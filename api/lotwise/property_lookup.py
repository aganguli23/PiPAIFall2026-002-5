"""Address -> lot facts, all from fast public APIs + local reference tables.

GeoSearch (address -> BBL, point)  ->  PLUTO (lot area, zoning, building)  ->  far_lookup (FAR from the
city's zoning tables)  ->  NTA 2020 (point in polygon on Socrata)  ->  BSF = lot area x max FAR."""
import math

import httpx

from . import db
from .config import SOCRATA_APP_TOKEN

GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search"
SOCRATA = "https://data.cityofnewyork.us/resource"
PLUTO_FIELDS = ("bbl,address,borough,zonedist1,zonedist2,overlay1,overlay2,spdist1,lotarea,lotfront,lotdepth,bldgarea,"
                "builtfar,numfloors,unitstotal,yearbuilt,bldgclass,landuse,ownername,latitude,longitude,mih_opt1,mih_opt2,mih_opt3")


def _headers():
    return {"X-App-Token": SOCRATA_APP_TOKEN} if SOCRATA_APP_TOKEN else {}


def geocode(text: str) -> dict | None:
    r = httpx.get(GEOSEARCH, params={"text": text, "size": 1}, timeout=15)
    r.raise_for_status()
    feats = r.json().get("features") or []
    if not feats:
        return None
    p = feats[0]["properties"]
    lon, lat = feats[0]["geometry"]["coordinates"]
    bbl = (p.get("addendum") or {}).get("pad", {}).get("bbl")
    return {"label": p.get("label"), "bbl": bbl, "lat": lat, "lon": lon, "borough": p.get("borough")}


def pluto(bbl: str) -> dict | None:
    hit = db.one("SELECT data FROM lots_cache WHERE bbl = %s AND fetched_at > now() - interval '30 days'", (bbl,))
    if hit:
        return hit["data"]
    r = httpx.get(f"{SOCRATA}/64uk-42ks.json", params={"$select": PLUTO_FIELDS, "$where": f"bbl='{bbl}'"},
                  headers=_headers(), timeout=20)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return None
    data = rows[0]
    db.run("""INSERT INTO lots_cache (bbl, data) VALUES (%s, %s)
              ON CONFLICT (bbl) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()""", (bbl, db.J(data)))
    return data


def nta_for_point(lat: float, lon: float) -> dict | None:
    r = httpx.get(f"{SOCRATA}/9nt8-h7nd.json",
                  params={"$select": "nta2020,ntaname,boroname", "$where": f"intersects(the_geom,'POINT({lon} {lat})')"},
                  headers=_headers(), timeout=20)
    r.raise_for_status()
    rows = r.json()
    return {"nta_code": rows[0]["nta2020"], "nta_name": rows[0]["ntaname"]} if rows else None


def far_for(zoning_code: str | None) -> dict | None:
    if not zoning_code:
        return None
    return db.one("SELECT * FROM far_lookup WHERE zoning_code = %s", (zoning_code.strip().upper(),))


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def nearest_subway_m(lat: float, lon: float) -> float | None:
    rows = db.all("""SELECT lat, lon FROM subway_stations
                     WHERE lat BETWEEN %s AND %s AND lon BETWEEN %s AND %s""",
                  (lat - 0.05, lat + 0.05, lon - 0.07, lon + 0.07))
    return round(min((haversine_m(lat, lon, r["lat"], r["lon"]) for r in rows), default=0)) or None


def nearest_ped(lat: float, lon: float) -> dict | None:
    rows = db.all("""SELECT loc_id, street, lat, lon, latest_count FROM ped_counts
                     WHERE lat BETWEEN %s AND %s AND lon BETWEEN %s AND %s""",
                  (lat - 0.03, lat + 0.03, lon - 0.04, lon + 0.04))
    if not rows:
        return None
    best = min(rows, key=lambda r: haversine_m(lat, lon, r["lat"], r["lon"]))
    return {"street": best["street"], "count": float(best["latest_count"] or 0),
            "dist_m": round(haversine_m(lat, lon, best["lat"], best["lon"]))}


def resolve_subject(address: str, extra_lots: list[str] | None = None) -> dict:
    """Everything the valuation engines need about the seller's site."""
    g = geocode(address)
    if not g or not g.get("bbl"):
        return {"ok": False, "error": f"Could not find a tax lot for '{address}'"}
    lot = pluto(g["bbl"]) or {}
    far = far_for(lot.get("zonedist1"))
    lotarea = float(lot.get("lotarea") or 0)
    lots = [{"bbl": g["bbl"], "lotarea": lotarea, "zonedist1": lot.get("zonedist1"), "far": far}]
    for extra in extra_lots or []:
        eg = geocode(extra) if not str(extra).isdigit() else {"bbl": str(extra)}
        if eg and eg.get("bbl"):
            el = pluto(eg["bbl"]) or {}
            lots.append({"bbl": eg["bbl"], "lotarea": float(el.get("lotarea") or 0), "zonedist1": el.get("zonedist1"),
                         "far": far_for(el.get("zonedist1"))})
    bsf = sum(l["lotarea"] * float((l["far"] or {}).get("max_far_narrow") or 0) for l in lots)
    bsf_qah = sum(l["lotarea"] * float((l["far"] or {}).get("max_far_qah_narrow") or (l["far"] or {}).get("max_far_narrow") or 0)
                  for l in lots)
    nta = nta_for_point(g["lat"], g["lon"]) or {}
    mih = any(str(lot.get(k, "")).lower() == "true" for k in ("mih_opt1", "mih_opt2", "mih_opt3"))
    return {
        "ok": True, "label": g["label"], "bbl": g["bbl"], "lat": g["lat"], "lon": g["lon"],
        "borough": g.get("borough"), "nta_code": nta.get("nta_code"), "nta_name": nta.get("nta_name"),
        "lotarea": sum(l["lotarea"] for l in lots), "lots": [{k: v for k, v in l.items() if k != "far"} for l in lots],
        "zonedist1": lot.get("zonedist1"), "overlay1": lot.get("overlay1"), "spdist1": lot.get("spdist1"),
        "bldgarea": float(lot.get("bldgarea") or 0), "builtfar": float(lot.get("builtfar") or 0),
        "bldgclass": lot.get("bldgclass"), "yearbuilt": lot.get("yearbuilt"),
        "max_far": float((far or {}).get("max_far_narrow") or 0), "max_far_use": (far or {}).get("max_far_use"),
        "qah_far": float((far or {}).get("qah_far_narrow") or 0) or None,
        "wide_narrow_differs": (far or {}).get("wide_narrow_differs") == "Y",
        "far_resolved": bool(far and far.get("max_far_narrow")),
        "bsf": round(bsf), "bsf_qah": round(bsf_qah), "mih": "Y" if mih else "N",
        "subway_dist_m": nearest_subway_m(g["lat"], g["lon"]), "ped": nearest_ped(g["lat"], g["lon"]),
    }


def neighbor_lots(bbl: str) -> dict:
    """Tax lots on the same block as `bbl`, nearest first, flagging the ones that share a side lot line.

    PLUTO has lot centroids and frontage/depth but no polygons, so "adjacent" is estimated: two lots on the same block whose
    centroids are no farther apart than ~1.25x their average frontage sit side by side. The seller confirms the list."""
    bbl = str(bbl).split(".")[0]
    if len(bbl) != 10 or not bbl.isdigit():
        return {"ok": False, "error": "need the subject lot's 10-digit BBL (run lookup_property first)"}
    boro, block = int(bbl[0]), int(bbl[1:6])
    r = httpx.get(f"{SOCRATA}/64uk-42ks.json", headers=_headers(), timeout=20, params={
        "$select": "bbl,address,lotarea,lotfront,lotdepth,zonedist1,landuse,latitude,longitude",
        "$where": f"borocode={boro} AND block={block}", "$limit": 500})
    r.raise_for_status()
    rows = [dict(x, bbl=str(x["bbl"]).split(".")[0]) for x in r.json() if x.get("latitude") and x.get("longitude")]
    me = next((x for x in rows if x["bbl"] == bbl), None)
    if not me:
        return {"ok": False, "error": f"lot {bbl} not found in PLUTO"}
    ft = 3.28084
    out = []
    for x in rows:
        if x["bbl"] == bbl:
            continue
        dist = haversine_m(float(me["latitude"]), float(me["longitude"]), float(x["latitude"]), float(x["longitude"])) * ft
        side = (float(me.get("lotfront") or 0) + float(x.get("lotfront") or 0)) / 2
        out.append({"bbl": x["bbl"], "address": (x.get("address") or "").title(), "lot_area_sf": round(float(x.get("lotarea") or 0)),
                    "zoning": x.get("zonedist1"), "distance_ft": round(dist), "adjacent": bool(side) and dist <= 1.25 * side})
    out.sort(key=lambda o: (not o["adjacent"], o["distance_ft"]))
    return {"ok": True, "block_lots": len(rows), "adjacent": [o for o in out if o["adjacent"]],
            "rest_of_block": [o for o in out if not o["adjacent"]][:8]}
