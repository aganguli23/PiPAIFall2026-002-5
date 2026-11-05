"""Settings. Env load order follows WebAppDev's API keys protocol: master WebAppDev/.env first,
then the app overlay (api/.env locally, /opt/lotwise/.env on the e2-micro); the overlay wins."""
import os
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parents[2]          # lotwise/app-*/
API_DIR = APP_DIR / "api"


def _workspace_root() -> Path | None:
    for p in [APP_DIR, *APP_DIR.parents]:
        if (p / "AGENTS.md").exists() and (p / ".env").exists():
            return p
    return None


_root = _workspace_root()
if _root:
    load_dotenv(_root / ".env")                       # master
load_dotenv(API_DIR / ".env", override=True)            # local overlay
load_dotenv("/opt/lotwise/.env", override=True)         # e2-micro overlay (only exists there)

DATABASE_URL = os.environ.get("LOTWISE_DATABASE_URL", "postgresql:///lotwise")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
SOCRATA_APP_TOKEN = os.environ.get("SOCRATA_APP_TOKEN", "")
INTAKE_MODEL = os.environ.get("LOTWISE_INTAKE_MODEL", "claude-haiku-5-5")
STT_MODEL = os.environ.get("LOTWISE_STT_MODEL", "gpt-4o-mini-transcribe")
TTS_MODEL = os.environ.get("LOTWISE_TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.environ.get("LOTWISE_TTS_VOICE", "alloy")
COOKIE_SECURE = os.environ.get("LOTWISE_COOKIE_SECURE", "0") == "1"
BASE_PATH = os.environ.get("LOTWISE_BASE_PATH", "/lotwise")
COOKIE_PATH = os.environ.get("LOTWISE_COOKIE_PATH", BASE_PATH or "/")
TC_VERSION = "2026-11-draft1"
APP_STAGE = os.environ.get("LOTWISE_STAGE", "skeleton")   # skeleton | draft1
