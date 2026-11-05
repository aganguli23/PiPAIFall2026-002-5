from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel

from . import auth, db
from .config import COOKIE_PATH, COOKIE_SECURE

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Signup(BaseModel):
    email: str
    password: str
    full_name: str
    phone: str | None = None


class Login(BaseModel):
    identifier: str      # email (sellers) or username (admins)
    password: str


def _set_cookie(resp: Response, token: str):
    resp.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax", secure=COOKIE_SECURE,
                    path=COOKIE_PATH, max_age=auth.SESSION_DAYS * 86400)


@router.post("/signup")
def signup(body: Signup, resp: Response):
    email = body.email.strip().lower()
    if "@" not in email or len(body.password) < 6:
        raise HTTPException(400, "Enter a valid email and a password of at least 6 characters")
    if db.one("SELECT 1 FROM users WHERE email = %s", (email,)):
        raise HTTPException(409, "An account with that email already exists")
    user = db.run("""INSERT INTO users (email, full_name, phone, role, password_hash)
                     VALUES (%s, %s, %s, 'seller', %s) RETURNING id, email, full_name, role""",
                  (email, body.full_name.strip(), body.phone, auth.hash_password(body.password)))
    _set_cookie(resp, auth.new_session(user["id"]))
    return user


@router.post("/login")
def login(body: Login, resp: Response):
    ident = body.identifier.strip().lower()
    user = db.one("SELECT * FROM users WHERE lower(email) = %s OR lower(username) = %s", (ident, ident))
    if not user or not auth.check_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Wrong email/username or password")
    _set_cookie(resp, auth.new_session(user["id"]))
    return {k: user[k] for k in ("id", "username", "email", "full_name", "role")}


@router.post("/logout")
def logout(resp: Response, lotwise_session: str | None = Cookie(default=None)):
    if lotwise_session:
        db.run("DELETE FROM sessions WHERE token = %s", (lotwise_session,))
    resp.delete_cookie(auth.COOKIE, path=COOKIE_PATH)
    return {"ok": True}


@router.get("/me")
def me(user: dict = Depends(auth.current_user)):
    return user
