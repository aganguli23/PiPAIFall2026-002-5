"""The seller intake field schema. One definition drives the AI conversation, the review form,
the red outlines (missing fields) and validation. Account fields live on the sign-up screen."""

USE_CASES = ["multifamily", "office", "retail", "hotel", "industrial", "mixed_use", "community_facility", "parking"]
CURRENT_USES = ["vacant_land", "parking_lot", "one_story_building", "occupied_building", "other"]
STRUCTURES = ["fee", "ground_lease", "air_rights"]

# kind: text | number | date | select | multiselect | bool | list | textarea
# required: True / False / "if:<rule>"; show: always unless "show" rule says otherwise
FIELDS = [
    {"key": "valuation_type", "label": "What kind of valuation", "kind": "select",
     "options": ["development_site", "fundamental"], "required": True,
     "ask": "Is this a development site you want valued on what can be built, or an existing income property?"},
    {"key": "address", "label": "Property address", "kind": "text", "required": True,
     "ask": "What's the property's address?"},
    {"key": "additional_lots", "label": "Other lots in the same sale (addresses or BBLs)", "kind": "list", "required": False,
     "ask": "Are any neighboring lots part of the same sale?"},
    {"key": "current_use", "label": "Current use", "kind": "select", "options": CURRENT_USES, "required": True,
     "ask": "What's on the site today?"},
    {"key": "is_vacant", "label": "Site is vacant (no tenants)", "kind": "bool", "required": True,
     "ask": "Is it vacant, or are there tenants?"},
    {"key": "occupied_units", "label": "Occupied units / tenants", "kind": "number", "required": "if:not_vacant",
     "show": "not_vacant", "ask": "How many units or tenants are occupied?"},
    {"key": "rent_regulated_units", "label": "Rent-regulated units", "kind": "number", "required": "if:not_vacant",
     "show": "not_vacant", "ask": "How many of those are rent-stabilized or rent-controlled?"},
    {"key": "rent_roll", "label": "Rent roll (upload or describe)", "kind": "textarea", "required": "if:not_vacant",
     "show": "not_vacant", "ask": "Could you upload the rent roll, or just describe the units and rents?"},
    {"key": "dob_plans", "label": "Filed or approved DOB plans (job #, type, floor area, units)", "kind": "textarea",
     "required": False, "ask": "Have any DOB plans been filed or approved?"},
    {"key": "air_rights_transfer", "label": "Air rights already sold or bought (and SF)", "kind": "text", "required": False,
     "ask": "Have any air rights been sold off or bought for this site? If so, roughly how many square feet?"},
    {"key": "environmental_issues", "label": "Known environmental issues", "kind": "textarea", "required": False,
     "ask": "Any environmental issues you know of?"},
    {"key": "encumbrances", "label": "Easements, restrictive declarations, liens or violations", "kind": "textarea",
     "required": False, "ask": "Any easements, restrictive declarations, liens or violations?"},
    {"key": "price_expectation", "label": "Price expectation (number or range)", "kind": "text", "required": False,
     "ask": "Do you have a price in mind?"},
    {"key": "target_sale_date", "label": "Target sale date", "kind": "date", "required": False,
     "ask": "When are you hoping to sell?"},
    {"key": "prior_offers", "label": "Prior listing or offers (price and date)", "kind": "textarea", "required": False,
     "ask": "Has it been listed before, or have you had offers?"},
    {"key": "valuation_use_cases", "label": "Valuation use cases (up to 2)", "kind": "multiselect", "options": USE_CASES,
     "max": 2, "required": False, "show": "development_site",
     "ask": "What would you or a buyer most likely build here (pick up to two), or should I choose?"},
    {"key": "sale_structures", "label": "Sale structure", "kind": "multiselect", "options": STRUCTURES,
     "required": "if:development_site", "show": "development_site",
     "ask": "How are you thinking of selling: an outright sale, a ground lease, an air rights sale, or more than one?"},
    {"key": "use_case", "label": "Property use case", "kind": "select", "options": USE_CASES,
     "required": "if:fundamental", "show": "fundamental", "ask": "What's the property used for today?"},
    {"key": "cap_rate", "label": "Cap rate (%)", "kind": "number", "required": "if:fundamental", "show": "fundamental",
     "ask": "What cap rate should I use?"},
    {"key": "residential_rent", "label": "Annual net residential rent ($/yr)", "kind": "number",
     "required": "if:fund_residential", "show": "fund_residential", "ask": "What's the annual residential rent, net of expenses?"},
    {"key": "commercial_rent", "label": "Annual net commercial rent ($/yr)", "kind": "number",
     "required": "if:fund_commercial", "show": "fund_commercial", "ask": "What's the annual commercial rent, net of expenses?"},
    {"key": "industrial_rent", "label": "Annual net industrial rent ($/yr)", "kind": "number",
     "required": "if:fund_industrial", "show": "fund_industrial", "ask": "What's the annual industrial rent, net of expenses?"},
    {"key": "parking_rent", "label": "Annual net parking rent ($/yr)", "kind": "number",
     "required": "if:fund_parking", "show": "fund_parking", "ask": "What's the annual parking income, net of expenses?"},
    {"key": "parking_sf", "label": "Parking SF", "kind": "number", "required": "if:fund_parking", "show": "fund_parking",
     "ask": "How many square feet of parking?"},
]
FIELD_KEYS = {f["key"] for f in FIELDS}
RULE_USES = {"fund_residential": {"multifamily", "mixed_use"}, "fund_commercial": {"office", "retail", "mixed_use", "hotel"},
             "fund_industrial": {"industrial"}, "fund_parking": {"parking"}}
SKIP = "__skip__"   # an optional field the seller chose to leave empty ("None / skip")


def rule_true(rule: str, f: dict) -> bool:
    vt = f.get("valuation_type")
    if rule == "not_vacant":
        return f.get("is_vacant") is False
    if rule in ("development_site", "fundamental"):
        return vt == rule
    if rule in RULE_USES:
        return vt == "fundamental" and f.get("use_case") in RULE_USES[rule]
    return True


def is_shown(field: dict, f: dict) -> bool:
    return "show" not in field or rule_true(field["show"], f)


def is_required(field: dict, f: dict) -> bool:
    req = field["required"]
    if isinstance(req, str) and req.startswith("if:"):
        return rule_true(req[3:], f)
    return bool(req) and is_shown(field, f)


def empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {}


def missing(f: dict) -> list[str]:
    """Fields to outline in red: shown, not filled and not explicitly skipped (optional fields can be skipped)."""
    out = []
    for field in FIELDS:
        if not is_shown(field, f):
            continue
        v = f.get(field["key"])
        if v == SKIP and not is_required(field, f):
            continue
        if empty(v) or v == SKIP:
            out.append(field["key"])
    return out


def next_question(f: dict) -> dict | None:
    """Required fields first, then optional ones."""
    gaps = missing(f)
    for want_required in (True, False):
        for field in FIELDS:
            if field["key"] in gaps and is_required(field, f) == want_required:
                return field
    return None


def public_schema() -> list[dict]:
    return [{k: v for k, v in f.items()} for f in FIELDS]
