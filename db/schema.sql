-- Lotwise Postgres schema (shared by the skeleton and the first full draft).
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql   (idempotent: CREATE ... IF NOT EXISTS)

-- ---------- users & sessions ----------
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  username      text UNIQUE,                 -- admins log in with a username
  email         text UNIQUE,                 -- sellers log in with email
  full_name     text,
  phone         text,
  role          text NOT NULL CHECK (role IN ('seller', 'admin')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS tc_acceptances (
  id                serial PRIMARY KEY,
  user_id           int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intake_session_id int,
  tc_version        text NOT NULL,
  accepted_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- AI intake ----------
CREATE TABLE IF NOT EXISTS intake_sessions (
  id          serial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode        text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'voice', 'form')),
  status      text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'review', 'submitted')),
  transcript  jsonb NOT NULL DEFAULT '[]',   -- [{role, text, at}]
  messages    jsonb NOT NULL DEFAULT '[]',   -- raw model conversation (for the agent loop)
  fields      jsonb NOT NULL DEFAULT '{}',   -- field_key -> value
  field_meta  jsonb NOT NULL DEFAULT '{}',   -- field_key -> {filled_by: ai|seller, at}
  subject     jsonb,                         -- resolved lot (bbl, lot area, zoning, FAR, BSF, NTA)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- reference data ----------
CREATE TABLE IF NOT EXISTS far_lookup (
  zoning_code            text PRIMARY KEY,
  table_kind             text,
  residential_equivalent text,
  resid_far_narrow       numeric,
  resid_far_wide         numeric,
  wide_narrow_differs    text,
  qah_far_narrow         numeric,
  qah_far_wide           numeric,
  commercial_far         numeric,
  manufacturing_far      numeric,
  max_far_narrow         numeric,
  max_far_use            text,
  max_far_qah_narrow     numeric
);
CREATE TABLE IF NOT EXISTS nta_2020 (
  nta_code text PRIMARY KEY,
  nta_name text NOT NULL,
  borough  text
);
CREATE TABLE IF NOT EXISTS lots_cache (
  bbl        text PRIMARY KEY,
  data       jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subway_stations (
  id     text PRIMARY KEY,
  name   text,
  routes text,
  lat    double precision,
  lon    double precision
);
CREATE TABLE IF NOT EXISTS ped_counts (
  loc_id         text PRIMARY KEY,
  street         text,
  borough        text,
  lat            double precision,
  lon            double precision,
  latest_count   numeric,
  latest_period  text
);

-- ---------- comps ----------
CREATE TABLE IF NOT EXISTS dev_site_sales (
  sale_id            text PRIMARY KEY,
  sale_date          date NOT NULL,
  sale_year          int,
  borough_name       text,
  nta_code           text,
  primary_bbl        text,
  lots_in_sale       int,
  zonedist1          text,
  zoning_family      text,
  sale_price         numeric,
  land_sf            numeric,
  bsf                numeric,
  max_far            numeric,
  price_per_bsf      numeric,
  price_per_land_sf  numeric,
  bsf_qah            numeric,
  price_per_bsf_qah  numeric,
  mih                text,
  usable_for_model   boolean,
  ppbsf_outlier      boolean,
  subway_dist_m      numeric,
  dob_nb_filings     int,
  lat                double precision,
  lon                double precision
);
CREATE INDEX IF NOT EXISTS dev_site_sales_latlon ON dev_site_sales (lat, lon);
CREATE INDEX IF NOT EXISTS dev_site_sales_date ON dev_site_sales (sale_date);
CREATE TABLE IF NOT EXISTS comp_features (
  sale_id          text PRIMARY KEY REFERENCES dev_site_sales(sale_id) ON DELETE CASCADE,
  ped_count        numeric,     -- nearest pedestrian count location (latest period)
  ped_dist_m       numeric,
  extra            jsonb NOT NULL DEFAULT '{}'
);

-- ---------- pricing parameters (set by the team) ----------
CREATE TABLE IF NOT EXISTS nta_multiples (
  nta_code    text PRIMARY KEY,
  multiple    numeric NOT NULL DEFAULT 1.0,
  comp_count  int,
  spread      numeric,
  approved_by text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  notes       text,
  is_placeholder boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS nta_multiple_history (
  id         serial PRIMARY KEY,
  nta_code   text NOT NULL,
  multiple   numeric NOT NULL,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  notes      text
);
CREATE TABLE IF NOT EXISTS structure_factors (
  structure  text PRIMARY KEY CHECK (structure IN ('fee', 'ground_lease', 'air_rights')),
  factor     numeric NOT NULL DEFAULT 1.0,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  notes      text,
  is_placeholder boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- ---------- ground lease / air rights (manual review, never OCR) ----------
CREATE TABLE IF NOT EXISTS acris_review (
  document_id      text PRIMARY KEY,
  queue            text NOT NULL CHECK (queue IN ('ground_lease', 'air_rights')),
  doc_type         text,
  document_date    date,
  recorded_date    date,
  amount           numeric,
  bbls             text[],
  addresses        text[],
  air_rights_flag  boolean,
  parties          jsonb NOT NULL DEFAULT '[]',
  remarks          text,
  detail_url       text,
  image_url        text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'yes', 'no', 'unsure')),
  reviewer         text,
  reviewed_at      timestamptz,
  review           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS acris_review_queue ON acris_review (queue, status, document_date DESC);
CREATE TABLE IF NOT EXISTS press_deals (
  id         serial PRIMARY KEY,
  source     text NOT NULL,            -- traded.co / therealdeal / other
  url        text,
  deal_date  date,
  address    text,
  bbl        text,
  structure  text CHECK (structure IN ('fee', 'ground_lease', 'air_rights')),
  price      numeric,
  sf         numeric,
  notes      text,
  entered_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS structure_comps (
  id               serial PRIMARY KEY,
  structure        text NOT NULL CHECK (structure IN ('ground_lease', 'air_rights')),
  source           text NOT NULL,     -- acris_review / press_deal / manual
  source_ref       text,
  bbl              text,
  address          text,
  nta_code         text,
  deal_date        date,
  price            numeric,
  sf               numeric,
  price_per_sf     numeric,
  implied_multiple numeric,           -- from the calibration workbench
  verified         boolean NOT NULL DEFAULT false,
  verified_by      text,
  lat              double precision,
  lon              double precision,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calibration_runs (
  id            serial PRIMARY KEY,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  subject       jsonb NOT NULL,
  sale_price    numeric NOT NULL,
  sale_date     date,
  sf_override   numeric,
  base_ppbsf    numeric,
  comps         jsonb NOT NULL DEFAULT '[]',
  implied       jsonb NOT NULL DEFAULT '{}',   -- {fee, ground_lease, air_rights}
  structure_comp_id int,
  notes         text
);

-- ---------- valuations ----------
CREATE TABLE IF NOT EXISTS valuations (
  id                serial PRIMARY KEY,
  user_id           int REFERENCES users(id) ON DELETE SET NULL,
  intake_session_id int,
  engine            text NOT NULL CHECK (engine IN ('devsite', 'fundamental')),
  structure         text,
  inputs            jsonb NOT NULL DEFAULT '{}',
  subject           jsonb NOT NULL DEFAULT '{}',
  base_ppbsf        numeric,
  nta_multiple      numeric,
  structure_factor  numeric,
  sway              numeric,
  value             numeric,
  value_low         numeric,
  value_high        numeric,
  confidence        numeric,
  versions          jsonb NOT NULL DEFAULT '{}',
  explanation       jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS valuation_comps (
  valuation_id     int NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  sale_id          text NOT NULL,
  rank             int,
  score            numeric,
  distance_km      numeric,
  comp_ppbsf       numeric,
  normalized_ppbsf numeric,
  weight           numeric,
  reason           text,
  included         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (valuation_id, sale_id)
);
CREATE TABLE IF NOT EXISTS comp_overrides (
  id           serial PRIMARY KEY,
  valuation_id int NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  sale_id      text NOT NULL,
  action       text NOT NULL CHECK (action IN ('remove', 'add')),
  reason       text,
  user_id      int,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id           serial PRIMARY KEY,
  valuation_id int NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  sha256       text NOT NULL,
  pdf          bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- referrals ----------
CREATE TABLE IF NOT EXISTS partners (
  id             serial PRIMARY KEY,
  partner_type   text NOT NULL,   -- listing_broker, appraiser, valuation_firm, attorney, surveyor, photographer, expediter, zoning_consultant
  name           text,
  firm           text,
  license_type   text,
  license_number text,
  license_active boolean,
  county         text,
  boroughs       text[],
  specialties    text,
  website        text,
  phone          text,
  email          text,
  source         text,            -- nys_dos / desk_research / manual
  source_url     text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS partner_deals (
  id         serial PRIMARY KEY,
  partner_id int NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  sale_ref   text,
  role       text,               -- seller-side broker, appraiser, counsel ...
  notes      text
);
CREATE TABLE IF NOT EXISTS referral_optins (
  id            serial PRIMARY KEY,
  user_id       int REFERENCES users(id) ON DELETE SET NULL,
  valuation_id  int REFERENCES valuations(id) ON DELETE SET NULL,
  partner_types text[] NOT NULL,
  consented_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referral_handoffs (
  id         serial PRIMARY KEY,
  optin_id   int NOT NULL REFERENCES referral_optins(id) ON DELETE CASCADE,
  partner_id int NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  score      numeric,
  reasons    text,
  status     text NOT NULL DEFAULT 'logged',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- models & time series (filled after training) ----------
CREATE TABLE IF NOT EXISTS model_registry (
  name       text PRIMARY KEY,     -- comp_ranker, referral_matcher, price_forecast
  version    text,
  kind       text,                 -- baseline / trained
  metrics    jsonb NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  notes      text
);
CREATE TABLE IF NOT EXISTS market_index (
  area       text NOT NULL,        -- borough or NTA code
  period     text NOT NULL,        -- e.g. 2025 or 2025Q3
  median_ppbsf numeric,
  n_sales    int,
  PRIMARY KEY (area, period)
);
CREATE TABLE IF NOT EXISTS valuation_snapshots (
  bbl          text NOT NULL,
  as_of        date NOT NULL,
  value_ppbsf  numeric,
  model_version text,
  PRIMARY KEY (bbl, as_of)
);
