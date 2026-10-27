-- Esquema base del CRM multi-escritorio.
-- PostGIS queda pospuesto (fase 2): usamos lat/lng en columnas numéricas.

CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  place_id          TEXT,
  nombre            TEXT NOT NULL,
  sector            TEXT,
  direccion         TEXT,
  ciudad            TEXT,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  telefono          TEXT,
  email             TEXT,
  web_detectada     BOOLEAN DEFAULT false,
  web_tipo          TEXT,               -- 'propia' | 'red social' | NULL
  redes             JSONB DEFAULT '[]'::jsonb,
  rating            NUMERIC,
  resenas           INTEGER,
  horario           TEXT,
  maps              TEXT,
  descripcion_ia    TEXT,
  score             INTEGER,
  estado            TEXT DEFAULT 'nuevo',
  motivo_descarte   TEXT,
  asignado_a        TEXT,
  search_id         TEXT,
  proxima_accion    TIMESTAMPTZ,
  proxima_tipo      TEXT,
  intentos          INTEGER DEFAULT 0,
  no_contactar      BOOLEAN DEFAULT false,
  fuente            TEXT,
  fotos             JSONB DEFAULT '[]'::jsonb,
  raw               JSONB,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_place_id_key
  ON leads (place_id) WHERE place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_asignado_idx ON leads (asignado_a);
CREATE INDEX IF NOT EXISTS leads_estado_idx ON leads (estado);

CREATE TABLE IF NOT EXISTS searches (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  sector       TEXT,
  zona         TEXT,
  radio        INTEGER,
  estado       TEXT,
  resultados   INTEGER DEFAULT 0,
  nuevos       INTEGER DEFAULT 0,
  duplicados   INTEGER DEFAULT 0,
  programada   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS searches_created_idx ON searches (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- v1.2.0 · usuarios, interacciones y deduplicación por teléfono.
-- Todo es idempotente: se puede ejecutar en cada arranque sobre una BD 1.1.x.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  nombre      TEXT NOT NULL,
  rol         TEXT NOT NULL CHECK (rol IN ('admin','supervisor','comercial','soporte')),
  pass_hash   TEXT NOT NULL,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS telefono_norm TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_ref    TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_by    TEXT;

UPDATE leads
   SET telefono_norm = regexp_replace(regexp_replace(telefono, '\D', '', 'g'), '^(0034|34)([0-9]{9})$', '\2')
 WHERE telefono_norm IS NULL AND telefono IS NOT NULL AND telefono <> '';

CREATE INDEX IF NOT EXISTS leads_telefono_norm_idx ON leads (telefono_norm) WHERE telefono_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);

CREATE TABLE IF NOT EXISTS lead_interactions (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id     TEXT,
  tipo        TEXT NOT NULL,
  resultado   TEXT,
  nota        TEXT,
  estado      TEXT,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_interactions_lead_idx ON lead_interactions (lead_id, fecha DESC);
