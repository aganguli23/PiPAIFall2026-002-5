"""AI spend caps, so nobody can drain the Anthropic / OpenAI keys.

Every paid call is metered into ai_usage (per user per day) and priced. Limits depend on WHO is asking (seller vs team
admin) and on the KIND of entry (typed message, spoken utterance, new intake, new account). When a cap is hit the app
degrades instead of breaking: chat drops to the free rule-based assistant (the seller can still finish the form), voice
asks the seller to type, and only hard abuse (message floods, account farming) is refused outright.

Override any limit with an env var, e.g. LOTWISE_CAP_SELLER_DAY_USD=2, LOTWISE_CAP_GLOBAL_DAY_USD=25."""
import os
import time
from collections import defaultdict, deque

from . import db

# Prices per unit (USD), slightly rounded up so estimates err on the safe side.
PRICE = {
    "in": 2.00 / 1e6,          # Claude Sonnet 5.5 input token
    "out": 10.00 / 1e6,        # output token
    "cache_read": 0.20 / 1e6,
    "cache_write": 2.50 / 1e6,
    "stt_sec": 0.003 / 60,     # gpt-4o-mini-transcribe, per second of audio
    "tts_char": 15.0 / 1e6,    # gpt-4o-mini-tts, per character spoken (generous)
}


def _cap(name: str, default: float) -> float:
    return float(os.environ.get(f"LOTWISE_CAP_{name.upper()}", default))


# Per kind of entry, per role. A full intake is ~25-40 messages and well under $0.50 of model time.
LIMITS = {
    "seller": {
        "msg_chars": _cap("seller_msg_chars", 1200),        # one typed message
        "burst_per_min": _cap("seller_burst_per_min", 10),  # typed + spoken turns per minute
        "session_turns": _cap("seller_session_turns", 60),  # AI turns per intake; after that, rule-based assistant
        "day_turns": _cap("seller_day_turns", 200),
        "day_usd": _cap("seller_day_usd", 1.50),
        "day_voice_sec": _cap("seller_day_voice_sec", 15 * 60),
        "day_sessions": _cap("seller_day_sessions", 8),     # new intakes started
    },
    "admin": {                                              # the team testing: higher, still bounded
        "msg_chars": _cap("admin_msg_chars", 4000),
        "burst_per_min": _cap("admin_burst_per_min", 30),
        "session_turns": _cap("admin_session_turns", 300),
        "day_turns": _cap("admin_day_turns", 1500),
        "day_usd": _cap("admin_day_usd", 10.0),
        "day_voice_sec": _cap("admin_day_voice_sec", 90 * 60),
        "day_sessions": _cap("admin_day_sessions", 100),
    },
}
GLOBAL_DAY_USD = _cap("global_day_usd", 20.0)               # whole app, all users: the hard ceiling on the bill
SIGNUPS_PER_IP_DAY = int(_cap("signups_per_ip_day", 5))

_burst: dict[int, deque] = defaultdict(deque)
_signups: dict[str, deque] = defaultdict(deque)


def ensure_table():
    db.run("""CREATE TABLE IF NOT EXISTS ai_usage (
                day        date NOT NULL DEFAULT current_date,
                user_id    int  NOT NULL,
                turns      int  NOT NULL DEFAULT 0,
                tokens_in  bigint NOT NULL DEFAULT 0,
                tokens_out bigint NOT NULL DEFAULT 0,
                voice_sec  numeric NOT NULL DEFAULT 0,
                tts_chars  int  NOT NULL DEFAULT 0,
                usd        numeric NOT NULL DEFAULT 0,
                PRIMARY KEY (day, user_id))""")


def limits_for(user_id: int) -> dict:
    row = db.one("SELECT role FROM users WHERE id = %s", (user_id,))
    return LIMITS["admin" if row and row["role"] == "admin" else "seller"]


def today(user_id: int) -> dict:
    return db.one("SELECT * FROM ai_usage WHERE day = current_date AND user_id = %s", (user_id,)) or \
        {"turns": 0, "usd": 0, "voice_sec": 0, "tts_chars": 0}


def global_usd_today() -> float:
    return float(db.one("SELECT coalesce(sum(usd), 0) s FROM ai_usage WHERE day = current_date")["s"])


def record(user_id: int, *, turns=0, tokens_in=0, tokens_out=0, cache_read=0, cache_write=0, voice_sec=0.0, tts_chars=0):
    usd = (tokens_in * PRICE["in"] + tokens_out * PRICE["out"] + cache_read * PRICE["cache_read"]
           + cache_write * PRICE["cache_write"] + voice_sec * PRICE["stt_sec"] + tts_chars * PRICE["tts_char"])
    db.run("""INSERT INTO ai_usage (user_id, turns, tokens_in, tokens_out, voice_sec, tts_chars, usd)
              VALUES (%s, %s, %s, %s, %s, %s, %s)
              ON CONFLICT (day, user_id) DO UPDATE SET turns = ai_usage.turns + EXCLUDED.turns,
                tokens_in = ai_usage.tokens_in + EXCLUDED.tokens_in, tokens_out = ai_usage.tokens_out + EXCLUDED.tokens_out,
                voice_sec = ai_usage.voice_sec + EXCLUDED.voice_sec, tts_chars = ai_usage.tts_chars + EXCLUDED.tts_chars,
                usd = ai_usage.usd + EXCLUDED.usd RETURNING day""",
           (user_id, turns, tokens_in + cache_read + cache_write, tokens_out, voice_sec, tts_chars, round(usd, 6)))


def burst_ok(user_id: int, lim: dict) -> bool:
    """Sliding one-minute window of turns (in memory; one app process)."""
    q, now = _burst[user_id], time.time()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= lim["burst_per_min"]:
        return False
    q.append(now)
    return True


def ai_turn_block(user_id: int, session: dict) -> str | None:
    """Why this turn must not use the paid model (None = allowed). Checked before every AI turn."""
    lim, used = limits_for(user_id), today(user_id)
    turns_in_session = sum(1 for m in (session.get("transcript") or []) if m.get("role") == "user")
    if turns_in_session >= lim["session_turns"]:
        return "session_turns"
    if used["turns"] >= lim["day_turns"]:
        return "day_turns"
    if float(used["usd"]) >= lim["day_usd"]:
        return "day_usd"
    if global_usd_today() >= GLOBAL_DAY_USD:
        return "global_usd"
    return None


def voice_block(user_id: int) -> str | None:
    lim, used = limits_for(user_id), today(user_id)
    if float(used["voice_sec"]) >= lim["day_voice_sec"]:
        return "day_voice"
    if float(used["usd"]) >= lim["day_usd"]:
        return "day_usd"
    if global_usd_today() >= GLOBAL_DAY_USD:
        return "global_usd"
    return None


def sessions_block(user_id: int) -> bool:
    lim = limits_for(user_id)
    n = db.one("SELECT count(*) n FROM intake_sessions WHERE user_id = %s AND created_at > current_date", (user_id,))["n"]
    return n >= lim["day_sessions"]


def signup_ok(ip: str) -> bool:
    q, now = _signups[ip], time.time()
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= SIGNUPS_PER_IP_DAY:
        return False
    q.append(now)
    return True
