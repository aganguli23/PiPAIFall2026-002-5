// Thin fetch wrapper. All calls go to /lotwise/api/* (nginx -> uvicorn on the e2-micro, Vite proxy locally).
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const d = data?.detail;
    const err = new Error(typeof d === "string" ? d : d?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = d;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => call("GET", p),
  post: (p, b) => call("POST", p, b ?? {}),
  put: (p, b) => call("PUT", p, b),
  patch: (p, b) => call("PATCH", p, b),
  url: (p) => BASE + p,
};

export const money = (v) => (v == null || v === "" ? "–" : "$" + Math.round(Number(v)).toLocaleString());
export const num = (v, d = 0) => (v == null || v === "" ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
export const label = (s) => String(s ?? "").replace(/_/g, " ");

// Server-sent events over POST (fetch stream): handlers = { delta, form, done, error }.
export async function stream(path, body, handlers) {
  const res = await fetch(BASE + path, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (ev && data && handlers[ev]) handlers[ev](JSON.parse(data));
    }
  }
}

export const wsUrl = (p) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${import.meta.env.BASE_URL.replace(/\/$/, "")}${p}`;
