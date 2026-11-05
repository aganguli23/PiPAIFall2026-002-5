"""SKELETON intake assistant: asks the next missing field and fills it from the reply with simple rules.
The first full draft swaps this for a Claude Haiku 5.5 conversation (same inputs/outputs: session in, reply +
updated fields out), plus voice on top."""
import re

from . import intake_fields as F


def _coerce(field: dict, text: str):
    t = text.strip()
    low = t.lower()
    if low in ("skip", "none", "no", "n/a", "not sure", "don't know") and not field["required"] is True and field["kind"] != "bool":
        return F.SKIP
    if field["kind"] == "bool":
        return not any(w in low for w in ("tenant", "occupied", "not vacant")) if field["key"] == "is_vacant" else low.startswith("y")
    if field["kind"] == "number":
        m = re.search(r"[\d.,]+", t)
        return float(m.group().replace(",", "")) if m else None
    if field["kind"] in ("select", "multiselect"):
        hits = [o for o in field["options"] if o.replace("_", " ") in low or o in low]
        if field["key"] == "valuation_type" and not hits:
            hits = ["fundamental"] if "income" in low or "existing" in low else ["development_site"]
        if field["key"] == "sale_structures" and not hits:
            hits = [s for s, w in (("fee", "sale"), ("ground_lease", "lease"), ("air_rights", "air")) if w in low]
        if not hits:
            return None
        return hits[: field.get("max", len(hits))] if field["kind"] == "multiselect" else hits[0]
    if field["kind"] == "list":
        return [p.strip() for p in re.split(r",|;| and ", t) if p.strip()]
    return t


def reply(session: dict, user_text: str | None) -> tuple[str, dict, list[str]]:
    """Returns (assistant text, updated fields, keys filled this turn)."""
    fields = dict(session.get("fields") or {})
    filled = []
    asked = (session.get("field_meta") or {}).get("_asked")
    if user_text and asked:
        field = next(f for f in F.FIELDS if f["key"] == asked)
        val = _coerce(field, user_text)
        if val is not None:
            fields[asked] = val
            filled.append(asked)
    nxt = F.next_question(fields)
    if not nxt:
        return "Thanks! That's everything. Review the form, fill anything outlined in red, accept the terms and continue.", fields, filled
    prefix = "Got it. " if filled else ("Hi! I'm the Lotwise valuation assistant (skeleton version). " if not user_text else "Sorry, I didn't catch that. ")
    session.setdefault("field_meta", {})["_asked"] = nxt["key"]
    return prefix + nxt["ask"] + ("" if F.is_required(nxt, fields) else " (optional, say 'skip')"), fields, filled
