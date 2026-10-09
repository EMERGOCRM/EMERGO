import { Router, Request, Response } from 'express';
import { query, dbEnabled } from '../db';

const router = Router();

interface LeadInput {
  id?: string;
  place_id?: string | null;
  nombre?: string;
  sector?: string;
  direccion?: string;
  ciudad?: string;
  lat?: number;
  lng?: number;
  telefono?: string;
  email?: string;
  web_detectada?: boolean;
  web_tipo?: string | null;
  redes?: unknown;
  rating?: number;
  resenas?: number;
  horario?: string;
  maps?: string;
  descripcion_ia?: string;
  score?: number;
  estado?: string;
  motivo_descarte?: string | null;
  asignado_a?: string | null;
  search_id?: string | null;
  proxima_accion?: string | null;
  proxima_tipo?: string | null;
  intentos?: number;
  no_contactar?: boolean;
  fuente?: string;
  fotos?: unknown;
  raw?: unknown;
}

function normalize(l: LeadInput): LeadInput {
  return {
    id: l.id || `L${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    place_id: l.place_id || null,
    nombre: l.nombre || 'Sin nombre',
    sector: l.sector || null,
    direccion: l.direccion || null,
    ciudad: l.ciudad || null,
    lat: typeof l.lat === 'number' ? l.lat : null,
    lng: typeof l.lng === 'number' ? l.lng : null,
    telefono: l.telefono || null,
    email: l.email || null,
    web_detectada: !!l.web_detectada,
    web_tipo: l.web_tipo || null,
    redes: l.redes || [],
    rating: typeof l.rating === 'number' ? l.rating : null,
    resenas: typeof l.resenas === 'number' ? l.resenas : 0,
    horario: l.horario || null,
    maps: l.maps || null,
    descripcion_ia: l.descripcion_ia || null,
    score: typeof l.score === 'number' ? l.score : null,
    estado: l.estado || 'nuevo',
    motivo_descarte: l.motivo_descarte || null,
    asignado_a: l.asignado_a || null,
    search_id: l.search_id || null,
    proxima_accion: l.proxima_accion || null,
    proxima_tipo: l.proxima_tipo || null,
    intentos: typeof l.intentos === 'number' ? l.intentos : 0,
    no_contactar: !!l.no_contactar,
    fuente: l.fuente || null,
    fotos: l.fotos || [],
    raw: l.raw || null
  };
}

const UPSERT = `
  INSERT INTO leads (
    id, place_id, nombre, sector, direccion, ciudad, lat, lng, telefono, email,
    web_detectada, web_tipo, redes, rating, resenas, horario, maps, descripcion_ia,
    score, estado, motivo_descarte, asignado_a, search_id, proxima_accion,
    proxima_tipo, intentos, no_contactar, fuente, fotos, raw, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
    $22,$23,$24,$25,$26,$27,$28,$29,$30, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    place_id=EXCLUDED.place_id, nombre=EXCLUDED.nombre, sector=EXCLUDED.sector,
    direccion=EXCLUDED.direccion, ciudad=EXCLUDED.ciudad, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
    telefono=EXCLUDED.telefono, email=EXCLUDED.email, web_detectada=EXCLUDED.web_detectada,
    web_tipo=EXCLUDED.web_tipo, redes=EXCLUDED.redes, rating=EXCLUDED.rating,
    resenas=EXCLUDED.resenas, horario=EXCLUDED.horario, maps=EXCLUDED.maps,
    descripcion_ia=EXCLUDED.descripcion_ia, score=EXCLUDED.score, estado=EXCLUDED.estado,
    motivo_descarte=EXCLUDED.motivo_descarte, asignado_a=EXCLUDED.asignado_a,
    search_id=EXCLUDED.search_id, proxima_accion=EXCLUDED.proxima_accion,
    proxima_tipo=EXCLUDED.proxima_tipo, intentos=EXCLUDED.intentos,
    no_contactar=EXCLUDED.no_contactar, fuente=EXCLUDED.fuente, fotos=EXCLUDED.fotos,
    raw=EXCLUDED.raw, updated_at=now()
`;

function params(l: LeadInput): unknown[] {
  const n = normalize(l);
  return [
    n.id, n.place_id, n.nombre, n.sector, n.direccion, n.ciudad, n.lat, n.lng, n.telefono, n.email,
    n.web_detectada, n.web_tipo, JSON.stringify(n.redes), n.rating, n.resenas, n.horario, n.maps,
    n.descripcion_ia, n.score, n.estado, n.motivo_descarte, n.asignado_a, n.search_id,
    n.proxima_accion, n.proxima_tipo, n.intentos, n.no_contactar, n.fuente,
    JSON.stringify(n.fotos), n.raw ? JSON.stringify(n.raw) : null
  ];
}

/**
 * POST /api/leads  -> array de leads o { leads: [...] }
 * Upsert por id, con detección de duplicado por place_id.
 */
router.post('/leads', async (req: Request, res: Response) => {
  if (!dbEnabled()) {
    res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL)' });
    return;
  }
  const raw = req.body;
  const list: LeadInput[] = Array.isArray(raw) ? raw : Array.isArray(raw?.leads) ? raw.leads : [];
  if (!list.length) {
    res.json({ saved: 0, leads: [] });
    return;
  }

  const saved: unknown[] = [];
  for (const item of list) {
    const n = normalize(item);
    if (n.place_id) {
      const existing = await query<{ id: string }>(
        'SELECT id FROM leads WHERE place_id = $1 LIMIT 1',
        [n.place_id]
      );
      if (existing.length && existing[0].id !== n.id) {
        const p = params({ ...n, id: existing[0].id });
        await query(UPSERT, p);
        saved.push({ ...n, id: existing[0].id, duplicate: true });
        continue;
      }
    }
    await query(UPSERT, params(n));
    saved.push(n);
  }

  res.json({ saved: saved.length, leads: saved });
});

/** GET /api/leads?estado=&asignado_a=&limit=&offset= */
router.get('/leads', async (req: Request, res: Response) => {
  if (!dbEnabled()) {
    res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL)' });
    return;
  }
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (req.query.estado) {
    args.push(req.query.estado);
    where.push(`estado = $${args.length}`);
  }
  if (req.query.asignado_a) {
    args.push(req.query.asignado_a);
    where.push(`asignado_a = $${args.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit, offset);
  const rows = await query(
    `SELECT * FROM leads ${clause} ORDER BY created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  res.json({ leads: rows, limit, offset });
});

/** GET /api/leads/:id */
router.get('/leads/:id', async (req: Request, res: Response) => {
  if (!dbEnabled()) {
    res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL)' });
    return;
  }
  const rows = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  if (!rows.length) {
    res.status(404).json({ error: 'Lead no encontrado' });
    return;
  }
  res.json({ lead: rows[0] });
});

export default router;
