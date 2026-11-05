// Fullscreen iMessage-style intake conversation (ported from the first full draft). In the skeleton the placeholder
// rule-based assistant answers via POST /message (no streaming, no voice); answers land in the form behind the sheet,
// which the seller reviews afterwards.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, label, num } from "../api.js";
import { isShown } from "./FieldForm.jsx";

const timeNow = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const SHORT = {
  valuation_type: "Type", address: "Address", additional_lots: "Other lots", current_use: "Current use", is_vacant: "Vacant",
  occupied_units: "Units", rent_regulated_units: "Regulated units", rent_roll: "Rent roll", dob_plans: "DOB plans",
  air_rights_transfer: "Air rights", environmental_issues: "Environmental", encumbrances: "Encumbrances",
  price_expectation: "Price expectation", target_sale_date: "Target date", prior_offers: "Prior offers",
  valuation_use_cases: "Use cases", sale_structures: "Sale structures", use_case: "Use case", cap_rate: "Cap rate",
  residential_rent: "Residential rent", commercial_rent: "Commercial rent", industrial_rent: "Industrial rent",
  parking_rent: "Parking rent", parking_sf: "Parking SF",
};

function display(v, skip) {
  if (v === skip) return "skipped";
  if (typeof v === "string" && v.length > 42) return v.slice(0, 40) + "…";
  if (Array.isArray(v)) return v.map(label).join(", ");
  if (v === true) return "yes";
  if (v === false) return "no";
  return label(v);
}

function LotCard({ s }) {
  return (
    <div className="ims-card">
      <div className="ims-card-top">
        <span className="ims-pin">📍</span>
        <div>
          <b>{s.label}</b>
          <div>{s.nta_name}</div>
        </div>
      </div>
      <div className="ims-card-grid">
        <div><small>Zoning</small>{s.zonedist1 || "–"}</div>
        <div><small>Lot area</small>{num(s.lotarea)} SF</div>
        <div><small>Max FAR</small>{s.max_far || "–"}</div>
        <div><small>Buildable</small>{num(s.bsf)} SF</div>
      </div>
      <div className="ims-card-foot">BBL {s.bbl} · from NYC city records</div>
    </div>
  );
}

export default function ChatSheet({ sid, s, setS, schema, skip, onClose }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState({});        // { user, assistant } for the turn in flight
  const [notes, setNotes] = useState([]);      // { at, kind: "saved" | "lot", ... } shown between bubbles
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState("");
  const turnAt = useRef(0);
  const prev = useRef({ fields: s.fields, subject: s.subject });
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const started = useRef(timeNow());

  useEffect(() => {
    document.body.style.overflow = "hidden";
    setTimeout(() => inputRef.current?.focus(), 500);
    return () => { document.body.style.overflow = ""; };
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); },
    [s.transcript.length, live.user, live.assistant, notes.length]);

  const labels = useMemo(() => Object.fromEntries(schema.map((f) => [f.key, f.label])), [schema]);

  // Form writes arrive mid-turn: diff them into "saved" notes and a lot card the first time the lot resolves.
  const applyForm = (f) => {
    const before = prev.current;
    const changed = Object.keys(f.fields || {}).filter((k) => JSON.stringify(f.fields[k]) !== JSON.stringify(before.fields?.[k])
      && f.fields[k] != null && f.fields[k] !== "");
    const add = [];
    if (changed.length) add.push({ at: turnAt.current + 1, kind: "saved", items: changed.map((k) => [SHORT[k] || labels[k] || label(k), display(f.fields[k], skip)]) });
    if (f.subject?.ok && f.subject.bbl !== before.subject?.bbl) add.push({ at: turnAt.current + 1, kind: "lot", subject: f.subject });
    if (add.length) setNotes((n) => [...n, ...add]);
    prev.current = { fields: f.fields, subject: f.subject ?? before.subject };
    setS((p) => ({ ...p, ...f }));
  };

  const send = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    setErr("");
    setBusy(true);
    turnAt.current = s.transcript.length;
    setLive({ user: t, assistant: "" });
    try {
      const view = await api.post(`/intake/sessions/${sid}/message`, { text: t });
      applyForm(view);
      prev.current = { fields: view.fields, subject: view.subject };
      setS(view);
    } catch {
      setErr("Not delivered. Check your connection and try again.");
      setText(t);
    }
    setLive({});
    setBusy(false);
    inputRef.current?.focus();
  };

  const close = () => { setClosing(true); setTimeout(onClose, 380); };

  // Thread = transcript (assistant replies split into separate bubbles on blank lines) + live turn + notes.
  const items = [];
  const pushMsg = (role, textValue, extra = {}) => {
    const parts = role === "assistant" ? String(textValue).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [textValue];
    parts.forEach((p) => items.push({ type: "msg", role, text: p, ...extra }));
  };
  const lotFromReload = s.subject?.ok && !notes.some((n) => n.kind === "lot") ? Math.min(2, s.transcript.length) : -1;
  const notesAt = (i) => {
    notes.filter((n) => n.at === i).forEach((n) => items.push({ type: n.kind, ...n }));
    if (i === lotFromReload) items.push({ type: "lot", subject: s.subject });
  };
  s.transcript.forEach((m, i) => { notesAt(i); pushMsg(m.role, m.text); });
  let n = s.transcript.length;
  if (live.user) { notesAt(n); pushMsg("user", live.user, { live: true }); n += 1; }
  notesAt(n);
  if (live.assistant) pushMsg("assistant", live.assistant, { live: true });
  else if ((live.user && live.user !== "…") || live.thinking) items.push({ type: "typing" });
  const msgs = items.map((it, i) => ({ ...it, tail: it.type === "msg" && !(items[i + 1]?.type === "msg" && items[i + 1].role === it.role) }));
  const lastUser = msgs.map((m) => m.type === "msg" && m.role === "user").lastIndexOf(true);

  const shown = schema.filter((f) => isShown(f, s.fields));
  const answered = shown.length - s.missing.length;
  const done = s.missing.length === 0 && !busy && !live.user;

  return (
    <div className={"ims-backdrop" + (closing ? " closing" : "")}>
      <div className="ims-sheet" role="dialog" aria-label="Chat with the Lotwise assistant">
        <header className="ims-head">
          <button className="ims-back" onClick={close} title="See the form">
            <span className="ims-chev">‹</span> Form <span className="ims-count">{answered}</span>
          </button>
          <div className="ims-who">
            <div className="ims-avatar">LW</div>
            <div className="ims-name">Lotwise <span>›</span></div>
          </div>
          <div className="ims-progress" title={`${answered} of ${shown.length} answered`}>
            <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" /><circle cx="18" cy="18" r="15" className="fg"
              style={{ strokeDasharray: `${(answered / Math.max(shown.length, 1)) * 94.2} 94.2` }} /></svg>
            <span>{answered}/{shown.length}</span>
          </div>
        </header>

        <div className="ims-thread">
          <div className="ims-inner">
            <div className="ims-stamp"><b>iMessage</b><br />Today {started.current}</div>
            {msgs.map((m, i) => {
              if (m.type === "typing") return <div key={i} className="ims-row them"><div className="ims-b them tail ims-typing"><i /><i /><i /></div></div>;
              if (m.type === "saved") return (
                <div key={i} className="ims-note">✓ Saved to your form: {m.items.map(([k, v]) => <span key={k}><b>{k}</b> {v}</span>)}</div>
              );
              if (m.type === "lot") return <div key={i} className="ims-row them"><LotCard s={m.subject} /></div>;
              return (
                <div key={i} className={"ims-row " + (m.role === "user" ? "me" : "them")}>
                  <div className={"ims-b " + (m.role === "user" ? "me" : "them") + (m.tail ? " tail" : "")}>{m.text}</div>
                  {i === lastUser && !m.live && <div className="ims-delivered">Delivered</div>}
                </div>
              );
            })}
            {done && (
              <div className="ims-finish">
                <div className="ims-note">All the questions are answered.</div>
                <button className="ims-cta" onClick={close}>Review your answers →</button>
              </div>
            )}
            {err && <div className="ims-err">⚠︎ {err}</div>}
            <div ref={endRef} />
          </div>
        </div>

        <form className="ims-compose" onSubmit={send}>
          <div className="ims-field">
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="iMessage" aria-label="Message" />
            <button className="ims-send" disabled={!text.trim() || busy} aria-label="Send">
              <svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
