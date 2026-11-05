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
