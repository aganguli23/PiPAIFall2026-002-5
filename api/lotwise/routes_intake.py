"""Intake: conversation -> fields (live form) -> review (red outlines) -> manual T&C -> valuation."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import auth, db, engines
from . import intake_agent as agent
from . import intake_fields as F
from .config import TC_VERSION
from .property_lookup import resolve_subject

router = APIRouter(prefix="/api/intake", tags=["intake"])


def _session(sid: int, user: dict) -> dict:
    s = db.one("SELECT * FROM intake_sessions WHERE id = %s AND user_id = %s", (sid, user["id"]))
    if not s:
        raise HTTPException(404, "Intake session not found")
    return s


def _view(s: dict) -> dict:
    return {"id": s["id"], "mode": s["mode"], "status": s["status"], "transcript": s["transcript"],
            "fields": s["fields"], "field_meta": {k: v for k, v in (s["field_meta"] or {}).items() if not k.startswith("_")},
            "missing": F.missing(s["fields"] or {}), "subject": s["subject"]}


@router.get("/schema")
def schema():
    return {"fields": F.public_schema(), "skip_token": F.SKIP, "tc_version": TC_VERSION}


class NewSession(BaseModel):
    mode: str = "chat"


@router.post("/sessions")
def new_session(body: NewSession, user: dict = Depends(auth.current_user)):
    init = agent.initial_state()
    s = db.run("""INSERT INTO intake_sessions (user_id, mode, transcript, messages) VALUES (%s, %s, %s, %s) RETURNING *""",
               (user["id"], body.mode if body.mode in ("chat", "voice", "form") else "chat",
                db.J(init["transcript"]), db.J(init["messages"])))
    return _view(s)


@router.get("/sessions/{sid}")
def get_session(sid: int, user: dict = Depends(auth.current_user)):
    return _view(_session(sid, user))


class Message(BaseModel):
    text: str


@router.post("/sessions/{sid}/message")
async def message(sid: int, body: Message, user: dict = Depends(auth.current_user)):
    s = await asyncio.to_thread(_session, sid, user)
    out = await agent.run_turn(s, body.text.strip()[:4000], mode="chat")
    s = await asyncio.to_thread(db.run, """UPDATE intake_sessions SET transcript = %s, messages = %s, fields = %s, field_meta = %s,
                     subject = %s, updated_at = now() WHERE id = %s RETURNING *""",
                     (db.J(out["transcript"]), db.J(out["messages"]), db.J(out["fields"]), db.J(out["field_meta"]),
                      db.J(out["subject"]) if out.get("subject") is not None else None, sid))
    return _view(s)


class FieldEdit(BaseModel):
    fields: dict


@router.put("/sessions/{sid}/fields")
def edit_fields(sid: int, body: FieldEdit, user: dict = Depends(auth.current_user)):
    s = _session(sid, user)
    fields, meta = s["fields"] or {}, s["field_meta"] or {}
    for k, v in body.fields.items():
        if k in F.FIELD_KEYS and fields.get(k) != v:
            fields[k] = v
            meta[k] = {"filled_by": "seller"}
    s = db.run("""UPDATE intake_sessions SET fields = %s, field_meta = %s, status = 'review', updated_at = now()
                  WHERE id = %s RETURNING *""", (db.J(fields), db.J(meta), sid))
    return _view(s)


@router.post("/sessions/{sid}/resolve")
def resolve(sid: int, user: dict = Depends(auth.current_user)):
    s = _session(sid, user)
    addr = (s["fields"] or {}).get("address")
    if not addr:
        raise HTTPException(400, "No address yet")
    extra = (s["fields"] or {}).get("additional_lots")
    subject = resolve_subject(addr, extra if isinstance(extra, list) else None)
    s = db.run("UPDATE intake_sessions SET subject = %s, updated_at = now() WHERE id = %s RETURNING *", (db.J(subject), sid))
    return _view(s)


class Submit(BaseModel):
    tc_accepted: bool


@router.post("/sessions/{sid}/submit")
def submit(sid: int, body: Submit, user: dict = Depends(auth.current_user)):
    s = _session(sid, user)
    f = s["fields"] or {}
    gaps = F.missing(f)
    if gaps:
        raise HTTPException(400, {"message": "Some fields still need an answer", "missing": gaps})
    if not body.tc_accepted:
        raise HTTPException(400, "Please accept the terms and conditions")
    db.run("INSERT INTO tc_acceptances (user_id, intake_session_id, tc_version) VALUES (%s, %s, %s)",
           (user["id"], sid, TC_VERSION))
    ids = []
    if f.get("valuation_type") == "fundamental":
        r = engines.value_fundamental(f)
        v = db.run("""INSERT INTO valuations (user_id, intake_session_id, engine, inputs, subject, value, value_low, value_high,
                      versions, explanation) VALUES (%s,%s,'fundamental',%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                   (user["id"], sid, db.J(f), db.J(s["subject"] or {"address": f.get("address")}), r["value"], r["value_low"],
                    r["value_high"], db.J({"engine": "skeleton"}), db.J({"noi": r["noi"], "cap_rate": r["cap_rate"]})))
        ids.append(v["id"])
    else:
        subject = s["subject"] or resolve_subject(f["address"], f.get("additional_lots") if isinstance(f.get("additional_lots"), list) else None)
        if not subject.get("ok"):
            raise HTTPException(400, subject.get("error") or "Could not resolve the address")
        for r in engines.value_devsite(subject, f.get("sale_structures") or ["fee"]):
            v = db.run("""INSERT INTO valuations (user_id, intake_session_id, engine, structure, inputs, subject, base_ppbsf,
                          nta_multiple, structure_factor, sway, value, value_low, value_high, confidence, versions, explanation)
                          VALUES (%s,%s,'devsite',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                       (user["id"], sid, r["structure"], db.J(f), db.J(subject), r["base_ppbsf"], r["nta_multiple"],
                        r["structure_factor"], r["sway"], r["value"], r["value_low"], r["value_high"], r["confidence"],
                        db.J({"engine": "skeleton", "ranker": "nearest-distance"}), db.J({"note": r["note"]})))
            for i, c in enumerate(r["comps"], 1):
                db.run("""INSERT INTO valuation_comps (valuation_id, sale_id, rank, distance_km, comp_ppbsf, reason)
                          VALUES (%s,%s,%s,%s,%s,%s)""",
                       (v["id"], c["sale_id"], i, c["distance_km"], c["price_per_bsf"], f"{c['distance_km']} km away"))
            ids.append(v["id"])
    db.run("UPDATE intake_sessions SET status = 'submitted', updated_at = now() WHERE id = %s", (sid,))
    return {"valuation_ids": ids}
