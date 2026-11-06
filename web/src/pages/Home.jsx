import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, label, money } from "../api.js";

export default function Home() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => { api.get("/valuations").then(setRows).catch(() => {}); }, []);

  const [err, setErr] = useState("");
  const start = async (mode) => {
    setBusy(true);
    setErr("");
    try {
      const s = await api.post("/intake/sessions", { mode });
      nav(`/intake/${s.id}`);
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="card start">
        <h2>Start a valuation</h2>
        <p>The assistant asks a few questions about your property and fills in the form for you. You review everything before
          anything is valued.</p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => start("chat")}>Chat with the assistant</button>
          <button className="secondary" disabled={busy} onClick={() => start("voice")}>Talk by voice</button>
        </div>
        {err && <div className="error">{err}</div>}
      </section>
      <section className="card">
        <h3>My valuations</h3>
        {rows.length === 0 ? <p className="muted">None yet.</p> : (
          <table>
            <thead><tr><th>#</th><th>Property</th><th>Engine</th><th>Structure</th><th>Value</th><th>Date</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => nav(`/results/${r.id}`)}>
                  <td><Link to={`/results/${r.id}`}>{r.id}</Link></td>
                  <td>{r.label || "–"}</td>
                  <td>{label(r.engine)}</td>
                  <td>{label(r.structure) || "–"}</td>
                  <td>{money(r.value)}</td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
