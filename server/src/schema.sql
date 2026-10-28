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
ALTER TABLE users ADD COLUMN IF NOT EXISTS desk TEXT NOT NULL DEFAULT 'leads';
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

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

-- ---------------------------------------------------------------------------
-- v1.3.0 · fotos, sincronización, exclusiones permanentes, búsquedas y demos.
-- ---------------------------------------------------------------------------

ALTER TABLE leads ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE lead_interactions ADD COLUMN IF NOT EXISTS client_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS lead_interactions_client_ref_key
  ON lead_interactions (lead_id, client_ref) WHERE client_ref IS NOT NULL;

-- Negocios que pidieron no ser contactados. Sobreviven al borrado del lead:
-- si vuelven a salir en una búsqueda, no se importan.
CREATE TABLE IF NOT EXISTS exclusions (
  id             TEXT PRIMARY KEY,
  place_id       TEXT,
  telefono_norm  TEXT,
  nombre         TEXT,
  motivo         TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS exclusions_place_key ON exclusions (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS exclusions_tel_idx ON exclusions (telefono_norm) WHERE telefono_norm IS NOT NULL;

ALTER TABLE searches ADD COLUMN IF NOT EXISTS proveedor TEXT;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS stats JSONB;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS lead_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS leads_search_idx ON leads (search_id);

CREATE TABLE IF NOT EXISTS demos (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  lead_id     TEXT REFERENCES leads(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('web','crm')),
  html        TEXT NOT NULL,
  prompt      TEXT,
  modelo      TEXT,
  visitas     INTEGER NOT NULL DEFAULT 0,
  ultima_visita TIMESTAMPTZ,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demos_lead_idx ON demos (lead_id, created_at DESC);
ALTER TABLE demos ADD COLUMN IF NOT EXISTS calidad TEXT;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS coste_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
