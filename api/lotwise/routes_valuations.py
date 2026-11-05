from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from . import auth, db
from .reports import build_pdf

router = APIRouter(prefix="/api/valuations", tags=["valuations"])

PARTNER_TYPES = ["listing_broker", "appraiser", "valuation_firm", "attorney", "surveyor", "photographer", "expediter",
                 "zoning_consultant"]


def _valuation(vid: int, user: dict) -> dict:
    v = db.one("SELECT * FROM valuations WHERE id = %s AND (user_id = %s OR %s)", (vid, user["id"], user["role"] == "admin"))
    if not v:
        raise HTTPException(404, "Valuation not found")
    return v


def _comps(vid: int) -> list[dict]:
    return db.all("""SELECT vc.*, s.sale_date, s.primary_bbl, s.zonedist1, s.sale_price, s.price_per_bsf, s.bsf, s.lat, s.lon,
                            s.nta_code, s.borough_name
                     FROM valuation_comps vc JOIN dev_site_sales s USING (sale_id)
                     WHERE vc.valuation_id = %s ORDER BY vc.rank""", (vid,))


@router.get("")
def mine(user: dict = Depends(auth.current_user)):
    return db.all("""SELECT id, engine, structure, value, value_low, value_high, created_at, subject->>'label' AS label
                     FROM valuations WHERE user_id = %s ORDER BY id DESC LIMIT 50""", (user["id"],))


@router.get("/{vid}")
def get(vid: int, user: dict = Depends(auth.current_user)):
    v = _valuation(vid, user)
    return {**v, "comps": _comps(vid)}


@router.get("/{vid}/report")
def report(vid: int, user: dict = Depends(auth.current_user)):
    v = _valuation(vid, user)
    pdf, digest = build_pdf(v, _comps(vid))
    db.run("INSERT INTO reports (valuation_id, sha256, pdf) VALUES (%s, %s, %s)", (vid, digest, pdf))
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="lotwise-valuation-{vid}.pdf"', "X-Report-SHA256": digest})


class Overrides(BaseModel):
    remove: list[str] = []
    add: list[str] = []
    reason: str | None = None


@router.post("/{vid}/comps")
def override_comps(vid: int, body: Overrides, user: dict = Depends(auth.current_user)):
    """Skeleton: logs the comp edits (future training labels) and flags excluded comps."""
    _valuation(vid, user)
    for sid in body.remove:
        db.run("INSERT INTO comp_overrides (valuation_id, sale_id, action, reason, user_id) VALUES (%s,%s,'remove',%s,%s)",
               (vid, sid, body.reason, user["id"]))
        db.run("UPDATE valuation_comps SET included = false WHERE valuation_id = %s AND sale_id = %s", (vid, sid))
    for sid in body.add:
        db.run("INSERT INTO comp_overrides (valuation_id, sale_id, action, reason, user_id) VALUES (%s,%s,'add',%s,%s)",
               (vid, sid, body.reason, user["id"]))
    return {"ok": True, "note": "Skeleton: edits are logged; the first draft re-values with the edited comp set."}


class OptIn(BaseModel):
    partner_types: list[str]


@router.post("/{vid}/referrals")
def referrals(vid: int, body: OptIn, user: dict = Depends(auth.current_user)):
    _valuation(vid, user)
    types = [t for t in body.partner_types if t in PARTNER_TYPES]
    if not types:
        raise HTTPException(400, "Pick at least one type of professional")
    optin = db.run("INSERT INTO referral_optins (user_id, valuation_id, partner_types) VALUES (%s,%s,%s) RETURNING id",
                   (user["id"], vid, types))
    matches = []
    for t in types:
        for p in db.all("""SELECT id, partner_type, name, firm, website, county FROM partners
                           WHERE partner_type = %s AND coalesce(license_active, true) ORDER BY random() LIMIT 3""", (t,)):
            db.run("INSERT INTO referral_handoffs (optin_id, partner_id, reasons) VALUES (%s,%s,%s)",
                   (optin["id"], p["id"], "skeleton: random active partner of this type"))
            matches.append(p)
    return {"optin_id": optin["id"], "matches": matches}


@router.get("/meta/partner-types")
def partner_types():
    return PARTNER_TYPES
