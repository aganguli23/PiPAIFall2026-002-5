// Fullscreen iMessage-style intake conversation (ported from the first full draft). It opens first, before the form.
// In the skeleton the placeholder rule-based assistant answers via POST /message (no streaming, no voice); each reply
// bubble is "typed" (typing dots, then the bubble) at a pace a little faster than a person types. The form behind the
// sheet unlocks after GATE messages from each side, when every question is answered, or on "Skip conversation".
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, label, num } from "../api.js";
import { isShown } from "./FieldForm.jsx";

export const GATE = 10;          // messages from EACH side before the form appears
const WPM = 375;                 // assistant "typing" speed (6.25x the first 60 wpm); a typical person types ~40 wpm
const MIN_TYPE_MS = 280;
const MAX_TYPE_MS = 3200;        // cap so one long bubble never stalls the chat
const typeMs = (t) => Math.min(MAX_TYPE_MS, Math.max(MIN_TYPE_MS, (t.trim().split(/\s+/).length / WPM) * 60000));

const splitReply = (t) => String(t).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
// Bubble counts per side, as the seller sees them (assistant replies split into bubbles on blank lines).
export function bubbleCounts(transcript) {
  let user = 0, ai = 0;
  for (const m of transcript || []) {
    if (m.role === "user") user += 1;
    else ai += splitReply(m.text).length;
  }
  return { user, ai };
}
export const gateMet = (transcript) => { const c = bubbleCounts(transcript); return c.user >= GATE && c.ai >= GATE; };

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

export default function ChatSheet({ sid, s, setS, schema, skip, unlocked, onUnlock, onClose }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState({});        // { user } or { thinking } for the turn in flight
  const [notes, setNotes] = useState([]);      // { at, kind: "saved" | "lot", ... } shown between bubbles
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState(0);       // how many thread items are revealed so far
  const [typing, setTyping] = useState(false); // assistant typing dots before the next bubble
  const turnAt = useRef(0);
  const prev = useRef({ fields: s.fields, subject: s.subject });
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const started = useRef(timeNow());
  const itemCount = useRef(0);
  const unlockSent = useRef(unlocked);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    setTimeout(() => inputRef.current?.focus(), 500);
    return () => { document.body.style.overflow = ""; };
  }, []);

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
    if (!t || busy || pacing) return;
    setText("");
    setErr("");
    setBusy(true);
    turnAt.current = s.transcript.length;
    setLive({ user: t });
    try {
      // Whole reply in one response; the pacer below types it out bubble by bubble.
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

  // Thread = transcript (assistant replies split into separate bubbles on blank lines) + the user's in-flight message + notes.
  const items = [];
  const pushMsg = (role, textValue, extra = {}) => {
    const parts = role === "assistant" ? splitReply(textValue) : [textValue];
    parts.forEach((p) => items.push({ type: "msg", role, text: p, ...extra }));
  };
  const lotFromReload = s.subject?.ok && !notes.some((n) => n.kind === "lot") ? Math.min(2, s.transcript.length) : -1;
  const notesAt = (i) => {
    notes.filter((n) => n.at === i).forEach((n) => items.push({ type: n.kind, ...n }));
    if (i === lotFromReload) items.push({ type: "lot", subject: s.subject });
  };
  s.transcript.forEach((m, i) => { notesAt(i); pushMsg(m.role, m.text); });
  let n = s.transcript.length;
  if (live.user && live.user !== "…") { notesAt(n); pushMsg("user", live.user, { live: true }); n += 1; }
  notesAt(n);
  itemCount.current = items.length;

  // Fresh conversation: type the greeting out. Reopened conversation: show its history at once.
  useLayoutEffect(() => {
    if (s.transcript.some((m) => m.role === "user")) setShown(itemCount.current);
  }, []);

  // Pacer: reveal items in order; the seller's own messages and notes appear at once, assistant bubbles get typing dots
  // for a time based on their length first.
  useEffect(() => {
    if (shown >= items.length) { setTyping(false); return; }
    const next = items[shown];
    if (next.type === "msg" && next.role === "assistant") {
      setTyping(true);
      const id = setTimeout(() => { setTyping(false); setShown((k) => k + 1); }, typeMs(next.text));
      return () => clearTimeout(id);
    }
    setShown((k) => k + 1);
  }, [shown, items.length]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [shown, typing, live.user]);

  const pacing = shown < items.length;
  const visible = items.slice(0, shown);
  const msgs = visible.map((it, i) => ({ ...it, tail: it.type === "msg" && !(visible[i + 1]?.type === "msg" && visible[i + 1].role === it.role) }));
  const lastUser = msgs.map((m) => m.type === "msg" && m.role === "user").lastIndexOf(true);
  const waiting = (busy || live.thinking || live.user === "…") && !pacing;

  const shownFields = schema.filter((f) => isShown(f, s.fields));
  const answered = shownFields.length - s.missing.length;
  const done = s.missing.length === 0 && !busy && !live.user && !pacing;

  // Gate: once GATE bubbles from each side have been seen, unlock the form and bring it up.
  const counts = { user: msgs.filter((m) => m.type === "msg" && m.role === "user").length,
                   ai: msgs.filter((m) => m.type === "msg" && m.role === "assistant").length };
  useEffect(() => {
    if (unlockSent.current || pacing || busy) return;
    if (counts.user >= GATE && counts.ai >= GATE) {
      unlockSent.current = true;
      const id = setTimeout(() => { onUnlock(); close(); }, 1200);
      return () => clearTimeout(id);
    }
  }, [counts.user, counts.ai, pacing, busy]);
  const skipToForm = () => { unlockSent.current = true; onUnlock(); close(); };

  return (
    <div className={"ims-backdrop" + (closing ? " closing" : "")}>
      <div className="ims-sheet" role="dialog" aria-label="Chat with the Lotwise assistant">
        <header className="ims-head">
          {unlocked ? (
            <button className="ims-back" onClick={close} title="See the form">
              <span className="ims-chev">‹</span> Form <span className="ims-count">{answered}</span>
            </button>
          ) : (
            <div className="ims-progress" title={`${answered} of ${shownFields.length} answered`}>
              <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" /><circle cx="18" cy="18" r="15" className="fg"
                style={{ strokeDasharray: `${(answered / Math.max(shownFields.length, 1)) * 94.2} 94.2` }} /></svg>
              <span>{answered}/{shownFields.length}</span>
            </div>
          )}
          <div className="ims-who">
            <div className="ims-avatar">LW</div>
            <div className="ims-name">Lotwise <span>›</span></div>
          </div>
          {unlocked ? (
            <div className="ims-progress" title={`${answered} of ${shownFields.length} answered`}>
              <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" /><circle cx="18" cy="18" r="15" className="fg"
                style={{ strokeDasharray: `${(answered / Math.max(shownFields.length, 1)) * 94.2} 94.2` }} /></svg>
              <span>{answered}/{shownFields.length}</span>
            </div>
          ) : (
            <button className="ims-skip" onClick={skipToForm} title="Skip the conversation and fill in the form yourself">
              Skip conversation
            </button>
          )}
        </header>

        <div className="ims-thread">
          <div className="ims-inner">
            <div className="ims-stamp">Today {started.current}</div>
            {msgs.map((m, i) => {
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
            {(typing || waiting) && <div className="ims-row them"><div className="ims-b them tail ims-typing"><i /><i /><i /></div></div>}
            {done && (
              <div className="ims-finish">
                <div className="ims-note">All the questions are answered.</div>
                <button className="ims-cta" onClick={skipToForm}>Review your answers →</button>
              </div>
            )}
            {err && <div className="ims-err">⚠︎ {err}</div>}
            <div ref={endRef} />
          </div>
        </div>

        <form className="ims-compose" onSubmit={send}>
          <div className="ims-field">
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Message" aria-label="Message" />
            <button className="ims-send" disabled={!text.trim() || busy || pacing} aria-label="Send">
              <svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
