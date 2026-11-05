import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, num } from "../api.js";
import FieldForm from "./FieldForm.jsx";
import VoicePanel from "./VoicePanel.jsx";

export default function Intake() {
  const { sid } = useParams();
  const nav = useNavigate();
  const [schema, setSchema] = useState(null);
  const [s, setS] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tc, setTc] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    api.get("/intake/schema").then(setSchema);
    api.get(`/intake/sessions/${sid}`).then(setS);
  }, [sid]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [s?.transcript?.length]);

  const send = async (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr("");
    const t = text;
    setText("");
    try { setS(await api.post(`/intake/sessions/${sid}/message`, { text: t })); }
    catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const edit = async (patch) => setS(await api.put(`/intake/sessions/${sid}/fields`, { fields: patch }));
  const lookup = async () => {
    setBusy(true);
    try { setS(await api.post(`/intake/sessions/${sid}/resolve`)); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.post(`/intake/sessions/${sid}/submit`, { tc_accepted: tc });
      nav(`/results/${r.valuation_ids[0]}?all=${r.valuation_ids.join(",")}`);
    } catch (x) {
      setErr(x.detail?.missing ? "Some fields still need an answer (outlined in red)." : x.message);
      setBusy(false);
    }
  };

  if (!schema || !s) return <div className="center muted">Loading…</div>;
  const ready = s.missing.length === 0;
  const subj = s.subject;
  return (
    <div className="intake">
      <section className="chat card">
        <h3>{s.mode === "voice" ? "Voice assistant" : "Chat with the assistant"}</h3>
        {s.mode === "voice" && <VoicePanel sid={sid} onUpdate={setS} />}
        <div className="messages">
          {s.transcript.map((m, i) => <div key={i} className={"bubble " + m.role}>{m.text}</div>)}
          <div ref={endRef} />
        </div>
        <form onSubmit={send} className="composer">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your answer…" disabled={busy} />
          <button className="primary" disabled={busy}>Send</button>
        </form>
      </section>
      <section className="form card">
        <h3>Your property details</h3>
        <p className="muted small">Filled in as you talk. Anything still empty is outlined in red. You can edit every field.</p>
        {s.fields.address && (
          <div className="lot">
            <button className="secondary small" onClick={lookup} disabled={busy}>Look up my lot</button>
            {subj?.ok && (
              <div className="lotfacts">
                <b>{subj.label}</b> · BBL {subj.bbl} · {subj.nta_name} ({subj.nta_code}) · zoning {subj.zonedist1} · lot {num(subj.lotarea)} SF ·
                max FAR {subj.max_far || "not in tables"} · <b>{num(subj.bsf)} buildable SF</b>
              </div>
            )}
            {subj && !subj.ok && <div className="error">{subj.error}</div>}
          </div>
        )}
        <FieldForm schema={schema.fields} fields={s.fields} missing={s.missing} meta={s.field_meta} skip={schema.skip_token} onChange={edit} />
        <div className="submitbar">
          <label className="tc">
            <input type="checkbox" checked={tc} onChange={(e) => setTc(e.target.checked)} />
            I have read and accept the terms and conditions. I understand this is an automated valuation, not an appraisal.
          </label>
          {err && <div className="error">{err}</div>}
          <button className="primary" disabled={!ready || !tc || busy} onClick={submit}>
            {ready ? "Continue to valuation" : `${s.missing.length} field(s) still need an answer`}
          </button>
        </div>
      </section>
    </div>
  );
}
