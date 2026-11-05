import { createContext, useContext, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api.js";
import Auth from "./pages/Auth.jsx";
import Home from "./pages/Home.jsx";
import Intake from "./pages/Intake.jsx";
import Results from "./pages/Results.jsx";
import Admin from "./pages/Admin.jsx";

const UserCtx = createContext(null);
export const useUser = () => useContext(UserCtx);

export default function App() {
  const [user, setUser] = useState(undefined);
  const nav = useNavigate();
  useEffect(() => {
    api.get("/auth/me").then(setUser).catch(() => setUser(null));
  }, []);
  const logout = async () => {
    await api.post("/auth/logout");
    setUser(null);
    nav("/");
  };
  if (user === undefined) return <div className="center muted">Loading…</div>;
  return (
    <UserCtx.Provider value={{ user, setUser }}>
      <header className="topbar">
        <Link to="/" className="brand">Lotwise</Link>
        <span className="tag">AI valuation assistant for NYC sellers</span>
        <nav>
          {user && <Link to="/">My valuations</Link>}
          {user?.role === "admin" && <Link to="/admin">Team admin</Link>}
          {user && <button className="link" onClick={logout}>Sign out ({user.username || user.email})</button>}
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={user ? <Home /> : <Auth />} />
          <Route path="/intake/:sid" element={user ? <Intake /> : <Navigate to="/" />} />
          <Route path="/results/:vid" element={user ? <Results /> : <Navigate to="/" />} />
          <Route path="/admin/*" element={user?.role === "admin" ? <Admin /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </UserCtx.Provider>
  );
}
