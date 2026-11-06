// Intake: the conversation comes first, fullscreen (ChatSheet). The form the assistant fills stays hidden until the
// conversation unlocks it (GATE messages from each side, every question answered, or "Skip conversation"); then it fades
// in and the seller edits anything (red outlines = still needed), checks the terms box themselves and continues.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, num } from "../api.js";
import ChatSheet, { gateMet } from "./ChatSheet.jsx";
import FieldForm from "./FieldForm.jsx";

const unlockKey = (sid) => `lotwise-form-unlocked-${sid}`;
const wasUnlocked = (sid) => { try { return localStorage.getItem(unlockKey(sid)) === "1"; } catch { return false; } };
const rememberUnlock = (sid) => { try { localStorage.setItem(unlockKey(sid), "1"); } catch { /* storage blocked: fine */ } };

export default function Intake() {
  const { sid } = useParams();
  const nav = useNavigate();
  const [schema, setSchema] = useState(null);
  const [s, setS] = useState(null);
  const [chat, setChat] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tc, setTc] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get("/intake/schema").then(setSchema);
    api.get(`/intake/sessions/${sid}`).then((v) => {
      setS(v);
      const u = v.status === "submitted" || v.status === "review" || wasUnlocked(sid) || gateMet(v.transcript);
      setUnlocked(u);
      setChat(!u);
    });
  }, [sid]);
  const unlock = () => { rememberUnlock(sid); setUnlocked(true); };

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
    <div className="review">
      {chat && <ChatSheet sid={sid} s={s} setS={setS} schema={schema.fields} skip={schema.skip_token}
        autoVoice={s.mode === "voice" && s.transcript.length <= 1} unlocked={unlocked} onUnlock={unlock}
        onClose={() => setChat(false)} />}
      {unlocked && !chat && <>
      <section className="card form-in">
        <div className="review-head">
          <div>
            <h2>Your property details</h2>
            <p className="muted small">Filled in from your conversation. Edit anything; fields outlined in red still need an answer.</p>
          </div>
          <button className="secondary" onClick={() => setChat(true)}>💬 Back to chat</button>
        </div>
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
      <button className="ims-fab" onClick={() => setChat(true)} aria-label="Open chat">
        <svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1L4.5 21l3.9-2c1.1.3 2.3.5 3.6.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z" /></svg>
      </button>
      </>}
    </div>
  );
}
