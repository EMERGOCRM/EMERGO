import { HttpError } from './http';

/** Estados válidos del lead (mismos que ESTADOS_LEAD en index.html). */
export const ESTADOS_LEAD = [
  'nuevo',
  'no_contesta',
  'callback',
  'presentado',
  'potencial',
  'no_interes',
  'numero_erroneo',
  'descartado',
  'convertido'
] as const;

export const TIPOS_INTERACCION = ['llamada', 'email', 'whatsapp', 'visita', 'nota', 'estado'] as const;

export const ROLES = ['admin', 'supervisor', 'comercial', 'soporte'] as const;
export type Rol = (typeof ROLES)[number];

const SOCIAL = [
  'facebook.',
  'instagram.',
  'tiktok.',
  'twitter.',
  'x.com',
  'youtube.',
  'youtu.be',
  'linkedin.',
  'pinterest.'
];

export function isSocialUrl(u: unknown): boolean {
  if (!u) return false;
  const l = String(u).toLowerCase();
  return SOCIAL.some((h) => l.includes(h));
}

// --- Coerciones tolerantes (importación) ----------------------------------

export function optStr(v: unknown, max = 500): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

export function optNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function optInt(v: unknown, min = 0, max = 1_000_000): number | null {
  const n = optNum(v);
  if (n === null) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Fecha ISO válida o null (nunca lanza: los textos tipo «mañana» se descartan). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function optDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  // Solo ISO 8601: `new Date('mañana a las 10')` devuelve octubre de 2001.
  const s = String(v).trim();
  if (!ISO_DATE.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function strArray(v: unknown, maxItems: number, maxLen = 500): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => optStr(x, maxLen))
    .filter((x): x is string => !!x)
    .slice(0, maxItems);
}

/** Teléfono normalizado para deduplicar: solo dígitos y sin prefijo 34/0034. */
export function phoneNorm(v: unknown): string | null {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  const m = /^(?:0034|34)(\d{9})$/.exec(d);
  return m ? m[1] : d;
}

/** Normaliza web_tipo a 'propia' | 'red social' | null. */
export function webTipo(v: unknown): 'propia' | 'red social' | null {
  const s = optStr(v, 1000);
  if (!s) return null;
  const l = s.toLowerCase();
  if (l === 'propia') return 'propia';
  // El frontend guarda el nombre de la red («instagram»), no la URL.
  const PLATAFORMAS = ['instagram', 'facebook', 'tiktok', 'twitter', 'x', 'youtube', 'linkedin', 'pinterest', 'whatsapp'];
  if (l === 'red social' || l === 'redes' || PLATAFORMAS.includes(l) || isSocialUrl(l)) return 'red social';
  return /^https?:\/\//.test(l) || l.includes('.') ? 'propia' : null;
}

function coord(v: unknown, limit: number): number | null {
  const n = optNum(v);
  return n === null || Math.abs(n) > limit ? null : n;
}

/** Solo URLs http(s) o del proxy propio; nunca rutas de assets locales. */
function imageUrl(v: unknown): string | null {
  const s = optStr(v, 2000);
  if (!s) return null;
  return /^https?:\/\//.test(s) || s.startsWith('/media/') ? s : null;
}

function rawJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    const s = JSON.stringify(v);
    return s.length <= 60_000 ? s : null;
  } catch {
    return null;
  }
}

// --- Lead de importación ---------------------------------------------------

export interface LeadImport {
  client_ref: string | null;
  place_id: string | null;
  nombre: string;
  sector: string | null;
  direccion: string | null;
  ciudad: string | null;
  lat: number | null;
  lng: number | null;
  telefono: string | null;
  telefono_norm: string | null;
  email: string | null;
  web_detectada: boolean;
  web_tipo: string | null;
  redes: string;
  rating: number | null;
  resenas: number | null;
  horario: string | null;
  maps: string | null;
  descripcion_ia: string | null;
  score: number | null;
  fuente: string | null;
  fotos: string;
  image_url: string | null;
  raw: string | null;
  // Campos de gestión: solo se usan al CREAR el lead, nunca al reimportar.
  estado: string;
  motivo_descarte: string | null;
  asignado_a: string | null;
  search_id: string | null;
  proxima_accion: string | null;
  proxima_tipo: string | null;
  intentos: number;
  no_contactar: boolean;
  created_at: string | null;
}

/**
 * Convierte un lead recibido en importación a una fila segura. Devuelve un
 * mensaje de error si el lead no se puede guardar (p. ej. sin nombre).
 */
export function normalizeImport(input: unknown): { lead?: LeadImport; error?: string } {
  if (!input || typeof input !== 'object') return { error: 'no es un objeto' };
  const l = input as Record<string, unknown>;
  const nombre = optStr(l.nombre, 200);
  if (!nombre) return { error: 'falta el nombre' };

  let lat = coord(l.lat, 90);
  let lng = coord(l.lng, 180);
  if (lat === 0 && lng === 0) lat = lng = null; // 0,0 = "sin coordenadas"
  if (lat === null || lng === null) lat = lng = null;

  const tipo = webTipo(l.web_tipo ?? l.web);
  const rating = optNum(l.rating);
  const estado = optStr(l.estado, 40) || 'nuevo';
  const telefono = optStr(l.telefono, 40);

  return {
    lead: {
      client_ref: optStr(l.id, 80),
      place_id: optStr(l.place_id, 200),
      nombre,
      sector: optStr(l.sector, 120),
      direccion: optStr(l.direccion, 300),
      ciudad: optStr(l.ciudad, 120),
      lat,
      lng,
      telefono,
      telefono_norm: phoneNorm(telefono),
      email: optStr(l.email, 200),
      web_detectada: tipo === 'propia',
      web_tipo: tipo,
      redes: JSON.stringify(strArray(l.redes, 10)),
      rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
      resenas: optInt(l.resenas),
      horario: optStr(l.horario, 300),
      maps: optStr(l.maps, 1000),
      descripcion_ia: optStr(l.descripcion_ia ?? l.desc, 4000),
      score: optInt(l.score, 0, 100),
      fuente: optStr(l.fuente, 120),
      fotos: JSON.stringify(strArray(l.fotos, 20, 1000).filter((f) => /^https?:\/\//.test(f) || f.startsWith('/media/'))),
      image_url: imageUrl(l.image_url ?? l.foto ?? l.imageUrl),
      raw: rawJson(l.raw),
      estado: (ESTADOS_LEAD as readonly string[]).includes(estado) ? estado : 'nuevo',
      motivo_descarte: optStr(l.motivo_descarte, 300),
      asignado_a: optStr(l.asignado_a ?? l.asignado, 80),
      search_id: optStr(l.search_id, 80),
      proxima_accion: optDate(l.proxima_accion),
      proxima_tipo: optStr(l.proxima_tipo, 40),
      intentos: optInt(l.intentos) ?? 0,
      no_contactar: l.no_contactar === true || l.no_contactar === 'true',
      // Fecha real de alta (leads que ya estaban en el navegador): nunca en el futuro.
      created_at: (() => {
        const d = optDate(l.created_at);
        return d && new Date(d).getTime() <= Date.now() + 60_000 ? d : null;
      })()
    }
  };
}

// --- Validación estricta (PATCH) -----------------------------------------

export function strictStr(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `«${key}» debe ser texto`);
  if (v.length > max) throw new HttpError(400, `«${key}» supera ${max} caracteres`);
  return v.trim();
}

export function strictDate(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === null || v === '') return null;
  const d = optDate(v);
  if (!d) throw new HttpError(400, `«${key}» no es una fecha válida (usa ISO 8601)`);
  return d;
}

export function strictInt(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = body[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `«${key}» debe ser un entero entre ${min} y ${max}`);
  }
  return v;
}

export function strictBool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  if (typeof v !== 'boolean') throw new HttpError(400, `«${key}» debe ser true o false`);
  return v;
}

export function strictEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T {
  const v = body[key];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new HttpError(400, `«${key}» debe ser uno de: ${values.join(', ')}`);
  }
  return v as T;
}
