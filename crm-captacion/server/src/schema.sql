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
