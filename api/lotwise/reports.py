"""PDF valuation report with a plain Lotwise header (fpdf2, small and pure Python)."""
import hashlib
from datetime import date

from fpdf import FPDF


def _money(v) -> str:
    return "-" if v is None else f"${float(v):,.0f}"


def build_pdf(valuation: dict, comps: list[dict]) -> tuple[bytes, str]:
    pdf = FPDF(format="Letter")
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 10, "Lotwise", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Automated valuation report  |  {date.today():%B %d, %Y}  |  Valuation #{valuation['id']}",
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    s = valuation.get("subject") or {}
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, s.get("label") or s.get("address") or "Subject property", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    rows = [
        ("Engine", valuation["engine"]), ("Sale structure", valuation.get("structure") or "-"),
        ("BBL", s.get("bbl")), ("Neighborhood (NTA 2020)", f"{s.get('nta_name') or '-'} ({s.get('nta_code') or '-'})"),
        ("Zoning", s.get("zonedist1")), ("Lot area (SF)", f"{s.get('lotarea') or 0:,.0f}"),
        ("Max FAR (zoning tables)", s.get("max_far")), ("Buildable SF", f"{s.get('bsf') or 0:,.0f}"),
        ("Base $/BSF from comps", _money(valuation.get("base_ppbsf"))), ("NTA multiple", valuation.get("nta_multiple")),
        ("Structure factor", valuation.get("structure_factor")),
        ("Estimated value", _money(valuation.get("value"))),
        ("Range", f"{_money(valuation.get('value_low'))} - {_money(valuation.get('value_high'))}"),
    ]
    for k, v in rows:
        pdf.cell(60, 6, str(k))
        pdf.cell(0, 6, str(v if v is not None else "-"), new_x="LMARGIN", new_y="NEXT")
    if comps:
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, "Comparable development-site sales", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "B", 8)
        for h, w in (("#", 8), ("Sale date", 24), ("BBL", 28), ("Zoning", 20), ("Price", 30), ("$/BSF", 22), ("Dist (km)", 20), ("Why", 0)):
            pdf.cell(w, 6, h)
        pdf.ln()
        pdf.set_font("Helvetica", "", 8)
        for i, c in enumerate(comps[:12], 1):
            for v, w in ((i, 8), (str(c.get("sale_date")), 24), (c.get("primary_bbl"), 28), (c.get("zonedist1"), 20),
                         (_money(c.get("sale_price")), 30), (_money(c.get("price_per_bsf")), 22), (c.get("distance_km"), 20)):
                pdf.cell(w, 5, str(v if v is not None else "-"))
            pdf.cell(0, 5, str(c.get("reason") or "")[:60], new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)
    pdf.set_font("Helvetica", "I", 8)
    pdf.multi_cell(0, 4, "This is an automated valuation produced by Lotwise from public records and the inputs you provided. "
                         "It is not an appraisal and should not be relied on as one.")
    data = bytes(pdf.output())
    return data, hashlib.sha256(data).hexdigest()
