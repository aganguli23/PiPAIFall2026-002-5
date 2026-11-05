"""Team admin API: review queues, press deals, calibration workbench, NTA multiples, structure factors,
structure comps, partners, settings, model registry."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import auth, db, engines
from .property_lookup import resolve_subject

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(auth.require_admin)])


@router.get("/stats")
def stats():
    q = lambda sql: db.one(sql)["n"]
    return {
        "dev_site_sales": q("SELECT count(*) n FROM dev_site_sales"),
        "usable_sales": q("SELECT count(*) n FROM dev_site_sales WHERE usable_for_model AND NOT ppbsf_outlier"),
        "gl_queue_pending": q("SELECT count(*) n FROM acris_review WHERE queue='ground_lease' AND status='pending'"),
        "air_queue_pending": q("SELECT count(*) n FROM acris_review WHERE queue='air_rights' AND status='pending'"),
        "structure_comps": q("SELECT count(*) n FROM structure_comps"),
        "press_deals": q("SELECT count(*) n FROM press_deals"),
        "calibration_runs": q("SELECT count(*) n FROM calibration_runs"),
        "placeholder_multiples": q("SELECT count(*) n FROM nta_multiples WHERE is_placeholder"),
        "partners": q("SELECT count(*) n FROM partners"),
        "valuations": q("SELECT count(*) n FROM valuations"),
        "users": q("SELECT count(*) n FROM users"),
    }


# ---------- ACRIS review queues (index data only; the team reads the documents) ----------
@router.get("/queues/{queue}")
def queue(queue: str, status: str = "pending", limit: int = 50, offset: int = 0):
    if queue not in ("ground_lease", "air_rights"):
        raise HTTPException(404)
    rows = db.all("""SELECT * FROM acris_review WHERE queue = %s AND status = %s
                     ORDER BY air_rights_flag DESC NULLS LAST, document_date DESC NULLS LAST LIMIT %s OFFSET %s""",
                  (queue, status, limit, offset))
    total = db.one("SELECT count(*) n FROM acris_review WHERE queue = %s AND status = %s", (queue, status))["n"]
    return {"total": total, "rows": rows}


class Review(BaseModel):
    status: str
    review: dict = {}


@router.patch("/queues/item/{document_id}")
def review_item(document_id: str, body: Review, admin: dict = Depends(auth.require_admin)):
    if body.status not in ("pending", "yes", "no", "unsure"):
        raise HTTPException(400, "bad status")
    return db.run("""UPDATE acris_review SET status = %s, review = %s, reviewer = %s, reviewed_at = now()
                     WHERE document_id = %s RETURNING document_id, status""",
                  (body.status, db.J(body.review), admin["username"], document_id))


# ---------- press deals (traded.co / The Real Deal) ----------
class PressDeal(BaseModel):
    source: str
    url: str | None = None
    deal_date: str | None = None
    address: str | None = None
    bbl: str | None = None
    structure: str
    price: float | None = None
    sf: float | None = None
    notes: str | None = None


@router.get("/press-deals")
def press_deals():
    return db.all("SELECT * FROM press_deals ORDER BY id DESC")


@router.post("/press-deals")
def add_press_deal(body: PressDeal, admin: dict = Depends(auth.require_admin)):
    return db.run("""INSERT INTO press_deals (source, url, deal_date, address, bbl, structure, price, sf, notes, entered_by)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                  (body.source, body.url, body.deal_date, body.address, body.bbl, body.structure, body.price, body.sf,
                   body.notes, admin["username"]))


# ---------- calibration workbench (reverse valuation) ----------
class Calibrate(BaseModel):
    address: str
    sale_price: float
    sale_date: str | None = None
    sf_override: float | None = None
    notes: str | None = None


@router.post("/calibration")
def calibrate(body: Calibrate, admin: dict = Depends(auth.require_admin)):
    subject = resolve_subject(body.address)
    if not subject.get("ok"):
        raise HTTPException(400, subject.get("error"))
    if body.sf_override:
        subject["bsf"] = body.sf_override
    r = engines.reverse_value(subject, body.sale_price, body.sale_date)
    run = db.run("""INSERT INTO calibration_runs (created_by, subject, sale_price, sale_date, sf_override, base_ppbsf, comps, implied, notes)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                 (admin["username"], db.J(subject), body.sale_price, body.sale_date, body.sf_override, r["base_ppbsf"],
                  db.J([{k: str(v) for k, v in c.items()} for c in r["comps"]]), db.J(r["implied"]), body.notes))
    return {"id": run["id"], "subject": subject, **r}


@router.get("/calibration")
def calibration_runs():
    return db.all("""SELECT id, created_by, created_at, subject->>'label' label, subject->>'nta_code' nta_code, sale_price,
                            sale_date, base_ppbsf, implied FROM calibration_runs ORDER BY id DESC LIMIT 200""")


# ---------- NTA multiples & structure factors ----------
@router.get("/nta-multiples")
def nta_multiples():
    return db.all("""SELECT n.nta_code, n.nta_name, n.borough, m.multiple, m.comp_count, m.spread, m.approved_by, m.updated_at,
                            m.notes, m.is_placeholder,
                            (SELECT count(*) FROM dev_site_sales s WHERE s.nta_code = n.nta_code AND s.usable_for_model) AS sales_in_nta
                     FROM nta_2020 n LEFT JOIN nta_multiples m USING (nta_code) ORDER BY n.borough, n.nta_name""")


class Multiple(BaseModel):
    nta_code: str
    multiple: float
    notes: str | None = None


@router.put("/nta-multiples")
def set_multiple(body: Multiple, admin: dict = Depends(auth.require_admin)):
    db.run("""INSERT INTO nta_multiples (nta_code, multiple, approved_by, notes, is_placeholder, updated_at)
              VALUES (%s,%s,%s,%s,false,now())
              ON CONFLICT (nta_code) DO UPDATE SET multiple = EXCLUDED.multiple, approved_by = EXCLUDED.approved_by,
                notes = EXCLUDED.notes, is_placeholder = false, updated_at = now()""",
           (body.nta_code, body.multiple, admin["username"], body.notes))
    db.run("INSERT INTO nta_multiple_history (nta_code, multiple, changed_by, notes) VALUES (%s,%s,%s,%s)",
           (body.nta_code, body.multiple, admin["username"], body.notes))
    return {"ok": True}


@router.get("/structure-factors")
def structure_factors():
    return db.all("SELECT * FROM structure_factors ORDER BY structure")


class Factor(BaseModel):
    structure: str
    factor: float
    notes: str | None = None


@router.put("/structure-factors")
def set_factor(body: Factor, admin: dict = Depends(auth.require_admin)):
    return db.run("""UPDATE structure_factors SET factor = %s, notes = %s, updated_by = %s, updated_at = now(), is_placeholder = false
                     WHERE structure = %s RETURNING *""", (body.factor, body.notes, admin["username"], body.structure))


# ---------- structure comps (verified ground leases / air rights) ----------
@router.get("/structure-comps")
def structure_comps():
    return db.all("SELECT * FROM structure_comps ORDER BY id DESC")


class StructureComp(BaseModel):
    structure: str
    source: str = "manual"
    source_ref: str | None = None
    address: str | None = None
    bbl: str | None = None
    deal_date: str | None = None
    price: float | None = None
    sf: float | None = None
    implied_multiple: float | None = None
    verified: bool = True
    notes: str | None = None


@router.post("/structure-comps")
def add_structure_comp(body: StructureComp, admin: dict = Depends(auth.require_admin)):
    lat = lon = nta = None
    if body.address:
        subj = resolve_subject(body.address)
        if subj.get("ok"):
            lat, lon, nta = subj["lat"], subj["lon"], subj["nta_code"]
    pps = round(body.price / body.sf, 2) if body.price and body.sf else None
    return db.run("""INSERT INTO structure_comps (structure, source, source_ref, bbl, address, nta_code, deal_date, price, sf,
                       price_per_sf, implied_multiple, verified, verified_by, lat, lon, notes)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                  (body.structure, body.source, body.source_ref, body.bbl, body.address, nta, body.deal_date, body.price,
                   body.sf, pps, body.implied_multiple, body.verified, admin["username"], lat, lon, body.notes))


# ---------- partners ----------
@router.get("/partners")
def partners(partner_type: str | None = None):
    if partner_type:
        return db.all("SELECT * FROM partners WHERE partner_type = %s ORDER BY name", (partner_type,))
    return db.all("SELECT * FROM partners ORDER BY partner_type, name")


class Partner(BaseModel):
    partner_type: str
    name: str | None = None
    firm: str | None = None
    website: str | None = None
    phone: str | None = None
    email: str | None = None
    boroughs: list[str] = []
    specialties: str | None = None
    license_number: str | None = None
    notes: str | None = None


@router.post("/partners")
def add_partner(body: Partner):
    return db.run("""INSERT INTO partners (partner_type, name, firm, website, phone, email, boroughs, specialties, license_number,
                       notes, source) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual') RETURNING *""",
                  (body.partner_type, body.name, body.firm, body.website, body.phone, body.email, body.boroughs,
                   body.specialties, body.license_number, body.notes))


# ---------- settings & models ----------
@router.get("/settings")
def settings():
    return db.all("SELECT * FROM settings ORDER BY key")


class Setting(BaseModel):
    key: str
    value: dict | list | float | int | str | bool


@router.put("/settings")
def set_setting(body: Setting):
    db.run("INSERT INTO settings (key, value) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
           (body.key, db.J(body.value)))
    return {"ok": True}


@router.get("/models")
def models():
    return db.all("SELECT * FROM model_registry ORDER BY name")
