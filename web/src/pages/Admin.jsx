import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, label, money, num } from "../api.js";

const TABS = [
  ["", "Overview"], ["gl", "Ground-lease queue"], ["air", "Air-rights queue"], ["press", "Press deals"],
  ["calibration", "Calibration workbench"], ["multiples", "NTA multiples"], ["structure", "Structure factors & comps"],
  ["partners", "Referral partners"], ["models", "Models & settings"],
];

export default function Admin() {
  return (
    <div className="page admin">
      <nav className="tabs">{TABS.map(([p, t]) => <NavLink key={p} end to={`/admin/${p}`}>{t}</NavLink>)}</nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="gl" element={<Queue queue="ground_lease" />} />
        <Route path="air" element={<Queue queue="air_rights" />} />
        <Route path="press" element={<Press />} />
        <Route path="calibration" element={<Calibration />} />
        <Route path="multiples" element={<Multiples />} />
        <Route path="structure" element={<Structure />} />
        <Route path="partners" element={<Partners />} />
        <Route path="models" element={<Models />} />
      </Routes>
    </div>
  );
}

function Overview() {
  const [s, setS] = useState(null);
  useEffect(() => { api.get("/admin/stats").then(setS); }, []);
  if (!s) return null;
  return (
    <section className="card">
      <h3>Status</h3>
      <div className="facts">{Object.entries(s).map(([k, v]) => <div key={k}>{label(k)}<b>{num(v)}</b></div>)}</div>
      <h4>Your next steps</h4>
      <ol>
        <li>Train the comp picker (see <code>models/README.md</code>) and register it.</li>
        <li>Review the ground-lease and air-rights queues; add traded.co / The Real Deal deals under Press deals.</li>
        <li>Run each verified deal through the Calibration workbench to get its implied multiples.</li>
        <li>Set NTA multiples and structure factors from those results; save verified deals as structure comps.</li>
        <li>Train the referral matcher and the price forecast.</li>
      </ol>
    </section>
  );
}

function Queue({ queue }) {
  const [status, setStatus] = useState("pending");
  const [data, setData] = useState({ total: 0, rows: [] });
  const [offset, setOffset] = useState(0);
  const load = () => api.get(`/admin/queues/${queue}?status=${status}&limit=25&offset=${offset}`).then(setData);
  useEffect(() => { load(); }, [queue, status, offset]);
  const mark = async (doc, st) => {
    const extra = st === "yes" ? { price: prompt("Price (if known)") || null, sf: prompt(queue === "air_rights" ? "SF transferred (if known)" : "Lease SF / BSF (if known)") || null, notes: prompt("Notes") || null } : {};
    await api.patch(`/admin/queues/item/${doc}`, { status: st, review: extra });
    load();
  };
  return (
    <section className="card">
      <h3>{queue === "ground_lease" ? "Ground-lease review queue (LEAS + MLEA)" : "Air-rights review queue (DEVR + AIRRIGHT)"}</h3>
      <p className="muted small">Index data from the ACRIS API only. Open each document and decide. Nothing here is OCR'd.</p>
      <div className="row">
        {["pending", "yes", "no", "unsure"].map((st) => <button key={st} className={"chip" + (status === st ? " on" : "")} onClick={() => { setStatus(st); setOffset(0); }}>{st}</button>)}
        <span className="muted">{data.total} documents</span>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>BBLs / addresses</th><th>Parties</th><th>Remarks</th><th>Docs</th><th>Decision</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.document_id}>
              <td>{r.document_date}</td><td>{r.doc_type}{r.air_rights_flag ? " · air flag" : ""}</td><td>{money(r.amount)}</td>
              <td className="small">{(r.addresses || []).join("; ")}<br />{(r.bbls || []).join(", ")}</td>
              <td className="small">{(r.parties || []).map((p) => `${p.type === "1" ? "P1" : "P2"}: ${p.name}`).join(" · ")}</td>
              <td className="small">{r.remarks}</td>
              <td><a href={r.detail_url} target="_blank" rel="noreferrer">detail</a> · <a href={r.image_url} target="_blank" rel="noreferrer">image</a></td>
              <td className="nowrap">
                <button className="chip" onClick={() => mark(r.document_id, "yes")}>yes</button>
                <button className="chip" onClick={() => mark(r.document_id, "no")}>no</button>
                <button className="chip" onClick={() => mark(r.document_id, "unsure")}>?</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="secondary small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Prev</button>
        <button className="secondary small" disabled={offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Next</button>
      </div>
    </section>
  );
}

function SimpleForm({ fields, onSubmit, submitLabel }) {
  const [f, setF] = useState({});
  return (
    <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); await onSubmit(f); setF({}); }}>
      {fields.map(([k, lab, type, opts]) => (
        <label key={k}>{lab}
          {opts ? (
            <select value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
              <option value="">Select…</option>{opts.map((o) => <option key={o} value={o}>{label(o)}</option>)}
            </select>
          ) : (
            <input type={type || "text"} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          )}
        </label>
      ))}
      <button className="primary">{submitLabel}</button>
    </form>
  );
}

const clean = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, ["price", "sf", "sale_price", "sf_override", "implied_multiple"].includes(k) ? Number(v) : v]));

function Press() {
  const [rows, setRows] = useState([]);
  const load = () => api.get("/admin/press-deals").then(setRows);
  useEffect(() => { load(); }, []);
  return (
    <section className="card">
      <h3>Press deals (traded.co, The Real Deal)</h3>
      <SimpleForm submitLabel="Add deal" onSubmit={async (f) => { await api.post("/admin/press-deals", clean(f)); load(); }}
        fields={[["source", "Source", null, ["traded.co", "therealdeal", "other"]], ["url", "Article URL"], ["deal_date", "Deal date", "date"],
          ["address", "Address"], ["bbl", "BBL"], ["structure", "Structure", null, ["fee", "ground_lease", "air_rights"]],
          ["price", "Price", "number"], ["sf", "SF", "number"], ["notes", "Notes"]]} />
      <table>
        <thead><tr><th>Date</th><th>Source</th><th>Address</th><th>Structure</th><th>Price</th><th>SF</th><th>By</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.deal_date}</td><td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.source}</a> : r.source}</td><td>{r.address}</td><td>{label(r.structure)}</td><td>{money(r.price)}</td><td>{num(r.sf)}</td><td>{r.entered_by}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Calibration() {
  const [res, setRes] = useState(null);
  const [runs, setRuns] = useState([]);
  const [err, setErr] = useState("");
  const load = () => api.get("/admin/calibration").then(setRuns);
  useEffect(() => { load(); }, []);
  return (
    <section className="card">
      <h3>Calibration workbench (reverse valuation)</h3>
      <p className="muted small">Value a property that already sold, with its actual price, to see the multiple each sale structure implies.</p>
      <SimpleForm submitLabel="Run reverse valuation" onSubmit={async (f) => {
        setErr("");
        try { setRes(await api.post("/admin/calibration", clean(f))); load(); } catch (x) { setErr(x.message); }
      }} fields={[["address", "Address or BBL"], ["sale_price", "Actual sale price", "number"], ["sale_date", "Sale date", "date"],
        ["sf_override", "SF override (e.g. air rights transferred)", "number"], ["notes", "Notes"]]} />
      {err && <div className="error">{err}</div>}
      {res && (
        <div className="calres">
          <b>{res.subject.label}</b> · {res.subject.nta_name} · BSF {num(res.subject.bsf)} · base {money(res.base_ppbsf)}/BSF
          <div className="facts">{Object.entries(res.implied).map(([k, v]) => <div key={k}>implied {label(k)} multiple<b>{num(v, 3)}</b></div>)}</div>
        </div>
      )}
      <table>
        <thead><tr><th>#</th><th>Property</th><th>NTA</th><th>Sale price</th><th>Base $/BSF</th><th>Fee</th><th>Ground lease</th><th>Air rights</th><th>By</th></tr></thead>
        <tbody>{runs.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.label}</td><td>{r.nta_code}</td><td>{money(r.sale_price)}</td><td>{money(r.base_ppbsf)}</td>
          <td>{num(r.implied?.fee, 3)}</td><td>{num(r.implied?.ground_lease, 3)}</td><td>{num(r.implied?.air_rights, 3)}</td><td>{r.created_by}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Multiples() {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("");
  const load = () => api.get("/admin/nta-multiples").then(setRows);
  useEffect(() => { load(); }, []);
  const save = async (r, val) => {
    const m = Number(val);
    if (!m || m === Number(r.multiple)) return;
    await api.put("/admin/nta-multiples", { nta_code: r.nta_code, multiple: m, notes: "set in admin" });
    load();
  };
  const shown = rows.filter((r) => !filter || `${r.nta_code} ${r.nta_name} ${r.borough}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="card">
      <h3>NTA 2020 multiples</h3>
      <p className="muted small">Placeholders are 1.0 until you set them from calibration runs. Changes take effect on the next valuation.</p>
      <input placeholder="Filter neighborhoods…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <table>
        <thead><tr><th>NTA</th><th>Neighborhood</th><th>Borough</th><th>Usable sales</th><th>Multiple</th><th>Status</th><th>By</th></tr></thead>
        <tbody>{shown.map((r) => (
          <tr key={r.nta_code}>
            <td>{r.nta_code}</td><td>{r.nta_name}</td><td>{r.borough}</td><td>{r.sales_in_nta}</td>
            <td><input className="tiny" defaultValue={r.multiple} onBlur={(e) => save(r, e.target.value)} /></td>
            <td>{r.is_placeholder ? <span className="warn">placeholder</span> : "set"}</td><td>{r.approved_by}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function Structure() {
  const [factors, setFactors] = useState([]);
  const [comps, setComps] = useState([]);
  const load = () => { api.get("/admin/structure-factors").then(setFactors); api.get("/admin/structure-comps").then(setComps); };
  useEffect(() => { load(); }, []);
  return (
    <>
      <section className="card">
        <h3>Structure factors</h3>
        <table>
          <thead><tr><th>Structure</th><th>Factor</th><th>Status</th><th>By</th></tr></thead>
          <tbody>{factors.map((f) => (
            <tr key={f.structure}><td>{label(f.structure)}</td>
              <td><input className="tiny" defaultValue={f.factor} onBlur={async (e) => { if (Number(e.target.value) !== Number(f.factor)) { await api.put("/admin/structure-factors", { structure: f.structure, factor: Number(e.target.value) }); load(); } }} /></td>
              <td>{f.is_placeholder ? <span className="warn">placeholder</span> : "set"}</td><td>{f.updated_by}</td></tr>
          ))}</tbody>
        </table>
      </section>
      <section className="card">
        <h3>Verified structure comps (ground leases & air rights)</h3>
        <SimpleForm submitLabel="Add verified deal" onSubmit={async (f) => { await api.post("/admin/structure-comps", clean(f)); load(); }}
          fields={[["structure", "Structure", null, ["ground_lease", "air_rights"]], ["source", "Source", null, ["acris_review", "press_deal", "manual"]],
            ["source_ref", "Doc ID / URL"], ["address", "Address"], ["deal_date", "Deal date", "date"], ["price", "Price", "number"],
            ["sf", "SF", "number"], ["implied_multiple", "Implied multiple (from calibration)", "number"], ["notes", "Notes"]]} />
        <table>
          <thead><tr><th>Structure</th><th>Address</th><th>NTA</th><th>Date</th><th>Price</th><th>SF</th><th>$/SF</th><th>Implied multiple</th><th>By</th></tr></thead>
          <tbody>{comps.map((c) => <tr key={c.id}><td>{label(c.structure)}</td><td>{c.address || c.bbl}</td><td>{c.nta_code}</td><td>{c.deal_date}</td><td>{money(c.price)}</td><td>{num(c.sf)}</td><td>{money(c.price_per_sf)}</td><td>{num(c.implied_multiple, 3)}</td><td>{c.verified_by}</td></tr>)}</tbody>
        </table>
      </section>
    </>
  );
}

function Partners() {
  const [rows, setRows] = useState([]);
  const load = () => api.get("/admin/partners").then(setRows);
  useEffect(() => { load(); }, []);
  const types = ["listing_broker", "appraiser", "valuation_firm", "attorney", "surveyor", "photographer", "expediter", "zoning_consultant"];
  return (
    <section className="card">
      <h3>Referral partners ({rows.length})</h3>
      <SimpleForm submitLabel="Add partner" onSubmit={async (f) => { await api.post("/admin/partners", { ...clean(f), boroughs: f.boroughs ? f.boroughs.split(",").map((s) => s.trim()) : [] }); load(); }}
        fields={[["partner_type", "Type", null, types], ["name", "Name"], ["firm", "Firm"], ["website", "Website"], ["phone", "Phone"],
          ["email", "Email"], ["boroughs", "Boroughs (comma separated)"], ["specialties", "Specialties"]]} />
      <table>
        <thead><tr><th>Type</th><th>Firm</th><th>Name</th><th>Boroughs</th><th>Specialties</th><th>License</th><th>Source</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id}><td>{label(p.partner_type)}</td><td>{p.website ? <a href={p.website} target="_blank" rel="noreferrer">{p.firm}</a> : p.firm}</td><td>{p.name}</td><td>{(p.boroughs || []).join(", ")}</td><td className="small">{p.specialties}</td><td className="small">{p.license_type} {p.license_number}</td><td>{p.source}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Models() {
  const [models, setModels] = useState([]);
  const [settings, setSettings] = useState([]);
  useEffect(() => { api.get("/admin/models").then(setModels); api.get("/admin/settings").then(setSettings); }, []);
  return (
    <>
      <section className="card">
        <h3>Model registry</h3>
        <table><thead><tr><th>Name</th><th>Version</th><th>Kind</th><th>Metrics</th><th>Notes</th></tr></thead>
          <tbody>{models.map((m) => <tr key={m.name}><td>{m.name}</td><td>{m.version}</td><td>{m.kind}</td><td className="small">{JSON.stringify(m.metrics)}</td><td className="small">{m.notes}</td></tr>)}</tbody></table>
      </section>
      <section className="card">
        <h3>Settings</h3>
        <table><tbody>{settings.map((s) => <tr key={s.key}><td>{s.key}</td><td><code className="small">{JSON.stringify(s.value)}</code></td></tr>)}</tbody></table>
      </section>
    </>
  );
}
