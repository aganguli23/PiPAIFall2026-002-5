"""Lotwise API. Run: uvicorn lotwise.main:app --port 8810 (from api/)."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, routes_admin, routes_auth, routes_intake, routes_valuations, voice
from .config import APP_DIR, APP_STAGE, BASE_PATH, INTAKE_MODEL


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.pool.open()
    yield
    db.pool.close()


app = FastAPI(title="Lotwise", lifespan=lifespan)
for r in (routes_auth, routes_intake, routes_valuations, routes_admin):
    app.include_router(r.router)


@app.middleware("http")
async def strip_base_path(request, call_next):
    """Accept /lotwise/api/... as well as /api/... (nginx forwards the prefix; local runs serve both)."""
    path = request.scope["path"]
    for prefix in (f"{BASE_PATH}/api", f"{BASE_PATH}/ws"):
        if BASE_PATH and path.startswith(prefix):
            request.scope["path"] = path[len(BASE_PATH):]
            break
    return await call_next(request)


@app.get("/api/health")
def health():
    n = db.one("SELECT count(*) n FROM dev_site_sales")["n"]
    return {"ok": True, "stage": APP_STAGE, "dev_site_sales": n}


@app.get("/api/voice/status")
def voice_status():
    return {"enabled": voice.enabled(), "stt": voice.STT_MODEL, "tts": voice.TTS_MODEL, "llm": INTAKE_MODEL}


@app.websocket("/ws/voice")
@app.websocket(f"{BASE_PATH}/ws/voice")
async def voice_ws(ws: WebSocket):
    await voice.voice_ws(ws)


# Local convenience: serve the built React app at BASE_PATH (nginx does this on the e2-micro).
DIST = APP_DIR / "web" / "dist"
if DIST.exists():
    app.mount(f"{BASE_PATH}/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get(BASE_PATH + "/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
