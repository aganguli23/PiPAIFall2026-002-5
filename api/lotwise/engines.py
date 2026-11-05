"""SKELETON engines: real data in, deliberately simple math out.

These show how user input -> database -> engine -> stored result fits together. The first full draft
replaces this module with the real comp selector, NTA multiples, structure factors and sway logic.

  dev-site value     = median $/BSF of the nearest comps  x  NTA multiple (placeholder 1.0)  x  BSF
  reverse (implied)  = actual sale price / (median $/BSF x BSF)
  fundamental value  = annual net rent / cap rate
"""
import statistics

from . import db
from .property_lookup import haversine_m

STRUCTURES = ("fee", "ground_lease", "air_rights")


def nearest_comps(subject: dict, n: int = 10, as_of: str | None = None) -> list[dict]:
    lat, lon = subject["lat"], subject["lon"]
    for box in (0.02, 0.05, 0.1, 0.3):
        rows = db.all("""SELECT sale_id, sale_date, nta_code, primary_bbl, zonedist1, sale_price, bsf, price_per_bsf, lat, lon
                         FROM dev_site_sales
                         WHERE usable_for_model AND NOT ppbsf_outlier AND lat IS NOT NULL
                           AND lat BETWEEN %s AND %s AND lon BETWEEN %s AND %s
                           AND (%s::date IS NULL OR sale_date < %s::date)""",
                      (lat - box, lat + box, lon - box * 1.3, lon + box * 1.3, as_of, as_of))
        if len(rows) >= n:
            break
    for r in rows:
        r["distance_km"] = round(haversine_m(lat, lon, r["lat"], r["lon"]) / 1000, 2)
    return sorted(rows, key=lambda r: r["distance_km"])[:n]


def nta_multiple(nta_code: str | None) -> float:
    row = db.one("SELECT multiple FROM nta_multiples WHERE nta_code = %s", (nta_code,))
    return float(row["multiple"]) if row else 1.0


def value_devsite(subject: dict, structures: list[str]) -> list[dict]:
    comps = nearest_comps(subject)
    base = statistics.median(float(c["price_per_bsf"]) for c in comps) if comps else 0.0
    mult = nta_multiple(subject.get("nta_code"))
    out = []
    for s in structures:
        value = base * mult * subject.get("bsf", 0)
        out.append({"structure": s, "base_ppbsf": round(base, 2), "nta_multiple": mult, "structure_factor": 1.0,
                    "sway": 0.0, "value": round(value), "value_low": round(value * 0.85), "value_high": round(value * 1.15),
                    "confidence": None, "comps": comps,
                    "note": "Skeleton placeholder: median of the 10 nearest comps x placeholder multiple."})
    return out


def reverse_value(subject: dict, sale_price: float, sale_date: str | None) -> dict:
    comps = nearest_comps(subject, as_of=sale_date)
    base = statistics.median(float(c["price_per_bsf"]) for c in comps) if comps else 0.0
    unadjusted = base * subject.get("bsf", 0)
    implied = round(sale_price / unadjusted, 3) if unadjusted else None
    return {"base_ppbsf": round(base, 2), "unadjusted_value": round(unadjusted), "comps": comps,
            "implied": {s: implied for s in STRUCTURES}}


def value_fundamental(inputs: dict) -> dict:
    noi = sum(float(inputs.get(k) or 0) for k in ("residential_rent", "commercial_rent", "industrial_rent", "parking_rent"))
    cap = float(inputs.get("cap_rate") or 0) / (100 if float(inputs.get("cap_rate") or 0) > 1 else 1)
    value = noi / cap if cap else 0
    return {"noi": round(noi), "cap_rate": cap, "value": round(value), "value_low": round(value * 0.9),
            "value_high": round(value * 1.1)}
