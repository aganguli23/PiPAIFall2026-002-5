# Lotwise skeleton

Placeholder app that shows the full path: user input -> backend model logic -> Postgres -> results page.
FastAPI + React + Postgres. Served under `/lotwise/`.

Environment variables (set in the host, never commit them):
- `LOTWISE_DATABASE_URL`  Postgres connection URL (on Railway: reference the Postgres service's `DATABASE_URL`)
- `LOTWISE_BASE_PATH`     default `/lotwise`
- `LOTWISE_COOKIE_SECURE` `1` behind HTTPS

Data is not stored in this repo. Load it into Postgres separately (schema in `db/schema.sql`).
