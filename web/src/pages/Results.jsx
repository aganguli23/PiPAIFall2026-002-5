import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import L from "leaflet";
import { api, label, money, num } from "../api.js";

function CompMap({ subject, comps }) {
  const el = useRef(null);
  useEffect(() => {
    if (!el.current || !subject?.lat) return;
    const map = L.map(el.current, { scrollWheelZoom: false }).setView([subject.lat, subject.lon], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
    const pts = [[subject.lat, subject.lon]];
    L.circleMarker([subject.lat, subject.lon], { radius: 9, color: "#c0392b", fillOpacity: 0.9 }).addTo(map).bindTooltip("Your site");
    comps.filter((c) => c.lat).forEach((c, i) => {
      pts.push([c.lat, c.lon]);
      L.circleMarker([c.lat, c.lon], { radius: 6, color: c.included ? "#1f3a5f" : "#999", fillOpacity: 0.7 })
        .addTo(map).bindTooltip(`#${i + 1} ${money(c.price_per_bsf)}/BSF`);
    });
    if (pts.length > 1) map.fitBounds(pts, { padding: [20, 20] });
    return () => map.remove();
  }, [subject, comps]);
  return <div ref={el} className="map" />;
}

export default function Results() {
  const { vid } = useParams();
  const [q] = useSearchParams();
  const all = (q.get("all") || vid).split(",");
  const [v, setV] = useState(null);
  const [types, setTypes] = useState([]);
  const [picked, setPicked] = useState([]);
  const [matches, setMatches] = useState(null);
  const [note, setNote] = useState("");

  const load = () => api.get(`/valuations/${vid}`).then(setV);
  useEffect(() => { load(); api.get("/valuations/meta/partner-types").then(setTypes); setMatches(null); setNote(""); }, [vid]);

  const toggleComp = async (c) => {
    const r = await api.post(`/valuations/${vid}/comps`, c.included ? { remove: [c.sale_id] } : { add: [c.sale_id] });
    setNote(r.note || "");
    if (r.valuation_id && String(r.valuation_id) !== vid) window.location.replace(window.location.pathname.replace(/\d+$/, r.valuation_id));
    else load();
  };
  const refer = async () => setMatches((await api.post(`/valuations/${vid}/referrals`, { partner_types: picked })).matches);

  if (!v) return <div className="center muted">Loading…</div>;
  const s = v.subject || {};
  return (
    <div className="page">
      {all.length > 1 && (
        <div className="tabs">
          {all.map((id) => <Link key={id} className={id === vid ? "on" : ""} to={`/results/${id}?all=${all.join(",")}`}>Valuation #{id}</Link>)}
        </div>
      )}
      <section className="card result">
        <div className="muted small">{v.engine === "devsite" ? "Development-site valuation" : "Fundamental valuation"}{v.structure ? ` · ${label(v.structure)}` : ""}</div>
        <h2>{s.label || s.address}</h2>
        <div className="value">{money(v.value)}</div>
        <div className="muted">Range {money(v.value_low)} – {money(v.value_high)}{v.confidence != null ? ` · confidence ${Math.round(v.confidence * 100)}%` : ""}</div>
        {v.engine === "devsite" ? (
          <div className="formula">
            <span>{money(v.base_ppbsf)}<small>base $/BSF from comps</small></span>×
            <span>{num(v.nta_multiple, 3)}<small>NTA multiple ({s.nta_code})</small></span>×
            <span>{num(v.structure_factor, 3)}<small>structure factor</small></span>
            {v.sway ? <>×<span>{num(1 + Number(v.sway), 3)}<small>nearby structure comps</small></span></> : null}×
            <span>{num(s.bsf)}<small>buildable SF</small></span>
          </div>
        ) : (
          <div className="formula"><span>{money(v.explanation?.noi)}<small>annual net income</small></span>÷<span>{num((v.explanation?.cap_rate || 0) * 100, 2)}%<small>cap rate</small></span></div>
        )}
        {v.explanation?.note && <p className="muted small">{v.explanation.note}</p>}
        {v.explanation?.warnings?.map((w, i) => <p key={i} className="warn small">{w}</p>)}
        <a className="secondary button" href={api.url(`/valuations/${vid}/report`)}>Download PDF report</a>
      </section>

      {v.engine === "devsite" && (
        <section className="card">
          <h3>Lot facts</h3>
          <div className="facts">
            <div>BBL<b>{s.bbl}</b></div><div>Neighborhood<b>{s.nta_name}</b></div><div>Zoning<b>{s.zonedist1}</b></div>
            <div>Lot area<b>{num(s.lotarea)} SF</b></div><div>Max FAR<b>{s.max_far || "–"}</b></div><div>Buildable SF<b>{num(s.bsf)}</b></div>
            <div>QAH buildable SF<b>{num(s.bsf_qah)}</b></div><div>MIH area<b>{s.mih}</b></div><div>Nearest subway<b>{num(s.subway_dist_m)} m</b></div>
          </div>
        </section>
      )}

      {v.comps?.length > 0 && (
        <section className="card">
          <h3>Comparable development-site sales</h3>
          <p className="muted small">Uncheck a comp to drop it from the valuation. Your edits help train the comp picker.</p>
          {note && <p className="warn small">{note}</p>}
          <CompMap subject={s} comps={v.comps} />
          <table>
            <thead><tr><th>Use</th><th>#</th><th>Sale date</th><th>BBL</th><th>Zoning</th><th>Price</th><th>BSF</th><th>$/BSF</th><th>Dist</th><th>Why chosen</th></tr></thead>
            <tbody>
              {v.comps.map((c, i) => (
                <tr key={c.sale_id} className={c.included ? "" : "excluded"}>
                  <td><input type="checkbox" checked={c.included} onChange={() => toggleComp(c)} /></td>
                  <td>{i + 1}</td><td>{c.sale_date}</td><td>{c.primary_bbl}</td><td>{c.zonedist1}</td>
                  <td>{money(c.sale_price)}</td><td>{num(c.bsf)}</td><td>{money(c.price_per_bsf)}</td><td>{num(c.distance_km, 2)} km</td>
                  <td className="small">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {v.explanation?.structure_comps?.length > 0 && (
            <>
              <h4>Nearby verified {label(v.structure)} deals</h4>
              <ul>{v.explanation.structure_comps.map((c) => <li key={c.id}>{c.address || c.bbl} · {c.deal_date} · {c.price ? money(c.price) : "price not disclosed"}{c.used ? " · used to adjust the multiple" : " · listed only"}</li>)}</ul>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h3>Get matched with professionals</h3>
        <p className="muted small">Pick who you'd like to hear from. We only share your details with the partners you opt in to.</p>
        <div className="chips">
          {types.map((t) => (
            <button key={t} className={"chip" + (picked.includes(t) ? " on" : "")}
              onClick={() => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t])}>{label(t)}</button>
          ))}
        </div>
        <button className="primary" disabled={!picked.length} onClick={refer}>Opt in and show matches</button>
        {matches && (
          <ul className="matches">
            {matches.length === 0 && <li className="muted">No partners of that type yet.</li>}
            {matches.map((m, i) => <li key={i}><b>{m.firm || m.name}</b> · {label(m.partner_type)}{m.website ? <> · <a href={m.website} target="_blank" rel="noreferrer">website</a></> : null}{m.reasons ? <span className="muted small"> · {m.reasons}</span> : null}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
