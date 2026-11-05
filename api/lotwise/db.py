"""Tiny Postgres helpers. Small pool so the e2-micro stays within max_connections."""
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=False)


@contextmanager
def conn():
    with pool.connection() as c:
        yield c


def all(sql: str, params=None) -> list[dict]:
    with conn() as c:
        return c.execute(sql, params or ()).fetchall()


def one(sql: str, params=None) -> dict | None:
    with conn() as c:
        return c.execute(sql, params or ()).fetchone()


def run(sql: str, params=None) -> dict | None:
    """Execute a write; returns the RETURNING row when there is one."""
    with conn() as c:
        cur = c.execute(sql, params or ())
        return cur.fetchone() if cur.description else None


def setting(key: str, default=None):
    row = one("SELECT value FROM settings WHERE key = %s", (key,))
    return row["value"] if row else default


J = Jsonb
