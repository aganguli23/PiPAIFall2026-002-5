import { label } from "../api.js";

// Mirrors api/lotwise/intake_fields.py rules (which fields are shown / required).
const RULE_USES = {
  fund_residential: ["multifamily", "mixed_use"],
  fund_commercial: ["office", "retail", "mixed_use", "hotel"],
  fund_industrial: ["industrial"],
  fund_parking: ["parking"],
};
export function ruleTrue(rule, f) {
  if (rule === "not_vacant") return f.is_vacant === false;
  if (rule === "development_site" || rule === "fundamental") return f.valuation_type === rule;
  if (RULE_USES[rule]) return f.valuation_type === "fundamental" && RULE_USES[rule].includes(f.use_case);
  return true;
}
export const isShown = (field, f) => !field.show || ruleTrue(field.show, f);
export const isRequired = (field, f) =>
  typeof field.required === "string" && field.required.startsWith("if:") ? ruleTrue(field.required.slice(3), f) : !!field.required && isShown(field, f);

export default function FieldForm({ schema, fields, missing, meta, skip, onChange }) {
  const set = (k, v) => onChange({ [k]: v });
  return (
    <div className="fieldform">
      {schema.filter((fd) => isShown(fd, fields)).map((fd) => {
        const v = fields[fd.key];
        const isMissing = missing.includes(fd.key);
        const skipped = v === skip;
        const req = isRequired(fd, fields);
        const by = meta?.[fd.key]?.filled_by;
        return (
          <div key={fd.key} className={"field" + (isMissing ? " missing" : "")}>
            <div className="flabel">
              {fd.label} {req ? <span className="req">required</span> : <span className="opt">optional</span>}
              {by && <span className={"by " + by}>{by === "ai" ? "filled by AI" : "edited by you"}</span>}
            </div>
            {skipped ? (
              <div className="skipped">Skipped · <button className="link" onClick={() => set(fd.key, null)}>answer instead</button></div>
            ) : (
              <Input fd={fd} v={v} set={(val) => set(fd.key, val)} />
            )}
            {!req && !skipped && <button className="link small" onClick={() => set(fd.key, skip)}>None / skip</button>}
          </div>
        );
      })}
    </div>
  );
}

function Input({ fd, v, set }) {
  if (fd.kind === "select")
    return (
      <select value={v ?? ""} onChange={(e) => set(e.target.value || null)}>
        <option value="">Select…</option>
        {fd.options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
      </select>
    );
  if (fd.kind === "multiselect") {
    const cur = Array.isArray(v) ? v : [];
    return (
      <div className="chips">
        {fd.options.map((o) => {
          const on = cur.includes(o);
          return (
            <button key={o} type="button" className={"chip" + (on ? " on" : "")}
              onClick={() => {
                let next = on ? cur.filter((x) => x !== o) : [...cur, o];
                if (fd.max && next.length > fd.max) next = next.slice(-fd.max);
                set(next.length ? next : null);
              }}>{label(o)}</button>
          );
        })}
      </div>
    );
  }
  if (fd.kind === "bool")
    return (
      <div className="chips">
        {[["Yes", true], ["No", false]].map(([t, b]) => (
          <button key={t} type="button" className={"chip" + (v === b ? " on" : "")} onClick={() => set(b)}>{t}</button>
        ))}
      </div>
    );
  if (fd.kind === "textarea")
    return <textarea rows={3} defaultValue={v ?? ""} onBlur={(e) => set(e.target.value || null)} />;
  if (fd.kind === "list")
    return <input defaultValue={Array.isArray(v) ? v.join("; ") : v ?? ""} placeholder="Separate with semicolons"
      onBlur={(e) => set(e.target.value ? e.target.value.split(";").map((s) => s.trim()).filter(Boolean) : null)} />;
  if (fd.kind === "number")
    return <input type="number" defaultValue={v ?? ""} onBlur={(e) => set(e.target.value === "" ? null : Number(e.target.value))} />;
  if (fd.kind === "date")
    return <input type="date" defaultValue={v ?? ""} onChange={(e) => set(e.target.value || null)} />;
  return <input defaultValue={v ?? ""} onBlur={(e) => set(e.target.value || null)} />;
}
