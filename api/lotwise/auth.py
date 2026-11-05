"""Email/password auth for sellers, username/password for admins. PBKDF2 (stdlib) + DB sessions."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException

from . import db

COOKIE = "lotwise_session"
SESSION_DAYS = 14


def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 240_000)
    return f"pbkdf2${salt}${dk.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 240_000)
    return hmac.compare_digest(dk.hex(), digest)


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (%s, %s, %s)",
           (token, user_id, datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)))
    return token


def user_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    return db.one("""SELECT u.id, u.username, u.email, u.full_name, u.phone, u.role
                     FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = %s AND s.expires_at > now()""", (token,))


def current_user(lotwise_session: str | None = Cookie(default=None)) -> dict:
    user = user_for_token(lotwise_session)
    if not user:
        raise HTTPException(401, "Not signed in")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Admins only")
    return user
