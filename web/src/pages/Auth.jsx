import { useState } from "react";
import { api } from "../api.js";
import { useUser } from "../App.jsx";

export default function Auth() {
  const { setUser } = useUser();
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ identifier: "", password: "", email: "", full_name: "", phone: "" });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const u = mode === "login"
        ? await api.post("/auth/login", { identifier: f.identifier, password: f.password })
        : await api.post("/auth/signup", { email: f.email, password: f.password, full_name: f.full_name, phone: f.phone || null });
      setUser(await api.get("/auth/me").catch(() => u));
    } catch (x) {
      setErr(x.message);
    }
  };

  return (
    <div className="auth">
      <section className="hero">
        <h1>What is your NYC site worth?</h1>
        <p>Talk to our AI valuation assistant by chat or voice. Lotwise looks up the zoning, works out the buildable square
          feet, picks comparable development-site sales and gives you a value in minutes.</p>
      </section>
      <form className="card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Create account</button>
        </div>
        {mode === "login" ? (
          <>
            <label>Email (sellers) or username (team)<input value={f.identifier} onChange={set("identifier")} autoComplete="username" /></label>
            <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="current-password" /></label>
          </>
        ) : (
          <>
            <label>Full name<input value={f.full_name} onChange={set("full_name")} /></label>
            <label>Email<input type="email" value={f.email} onChange={set("email")} autoComplete="email" /></label>
            <label>Phone<input value={f.phone} onChange={set("phone")} autoComplete="tel" /></label>
            <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" /></label>
          </>
        )}
        {err && <div className="error">{err}</div>}
        <button className="primary">{mode === "login" ? "Sign in" : "Create account"}</button>
        <p className="muted small">Google sign-in is coming later.</p>
      </form>
    </div>
  );
}
