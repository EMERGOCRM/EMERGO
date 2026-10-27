import crypto from 'crypto';
import { Router, Request } from 'express';
import { PoolClient } from 'pg';
import { query, withClient } from '../db';
import { ah, HttpError } from '../http';
import { AuthUser, requireRole, seesAll } from '../auth';
import {
  ESTADOS_LEAD,
  LeadImport,
  TIPOS_INTERACCION,
  normalizeImport,
  optStr,
  phoneNorm,
  strictBool,
  strictDate,
  strictEnum,
  strictInt,
  strictStr
} from '../validate';

const router = Router();

const MAX_BATCH = 500;

/** Columnas devueltas en listados (sin `raw`, que pesa mucho). */
const LIST_COLS = `id, place_id, nombre, sector, direccion, ciudad, lat, lng, telefono, email,
  web_detectada, web_tipo, redes, rating, resenas, horario, maps, descripcion_ia, score, estado,
  motivo_descarte, asignado_a, search_id, proxima_accion, proxima_tipo, intentos, no_contactar,
  fuente, fotos, client_ref, created_by, created_at, updated_at`;

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
}

/** Condición SQL de visibilidad: comercial y soporte ven lo suyo y lo libre. */
function visibility(user: AuthUser | undefined, args: unknown[]): string {
  if (seesAll(user)) return 'TRUE';
  args.push(user?.id || '');
  return `(asignado_a = $${args.length} OR asignado_a IS NULL)`;
}

async function loadVisible(c: PoolClient, req: Request, id: string, lock = false) {
  const args: unknown[] = [id];
  const vis = visibility(req.user, args);
  const r = await c.query(
    `SELECT ${LIST_COLS} FROM leads WHERE id = $1 AND ${vis}${lock ? ' FOR UPDATE' : ''}`,
    args
  );
  if (!r.rows.length) throw new HttpError(404, 'Lead no encontrado');
  return r.rows[0];
}

// --- Importación -----------------------------------------------------------

/**
 * Al reimportar un negocio que ya existe SOLO se refrescan los datos de
 * Google Maps. Estado, asignación, intentos, próxima acción y no_contactar
 * nunca se tocan. Los valores vacíos no borran lo que ya había.
 */
const MAPS_REFRESH = `
  nombre = $2,
  sector = COALESCE($3, leads.sector),
  direccion = COALESCE($4, leads.direccion),
  ciudad = COALESCE($5, leads.ciudad),
  lat = COALESCE($6, leads.lat),
  lng = COALESCE($7, leads.lng),
  telefono = COALESCE($8, leads.telefono),
  telefono_norm = COALESCE($9, leads.telefono_norm),
  email = COALESCE($10, leads.email),
  web_detectada = $11,
  web_tipo = COALESCE($12, leads.web_tipo),
  redes = CASE WHEN jsonb_array_length($13::jsonb) > 0 THEN $13::jsonb ELSE leads.redes END,
  rating = COALESCE($14, leads.rating),
  resenas = COALESCE($15, leads.resenas),
  horario = COALESCE($16, leads.horario),
  maps = COALESCE($17, leads.maps),
  fotos = CASE WHEN jsonb_array_length($18::jsonb) > 0 THEN $18::jsonb ELSE leads.fotos END,
  raw = COALESCE($19::jsonb, leads.raw),
  updated_at = now()`;

function mapsParams(id: string, n: LeadImport): unknown[] {
  return [
    id, n.nombre, n.sector, n.direccion, n.ciudad, n.lat, n.lng, n.telefono, n.telefono_norm,
    n.email, n.web_detectada, n.web_tipo, n.redes, n.rating, n.resenas, n.horario, n.maps,
    n.fotos, n.raw
  ];
}

async function refreshMaps(c: PoolClient, id: string, n: LeadImport) {
  const r = await c.query(
    `UPDATE leads SET ${MAPS_REFRESH} WHERE id = $1 RETURNING ${LIST_COLS}`,
    mapsParams(id, n)
  );
  return r.rows[0];
}

const INSERT = `
  INSERT INTO leads (
    id, nombre, sector, direccion, ciudad, lat, lng, telefono, telefono_norm, email,
    web_detectada, web_tipo, redes, rating, resenas, horario, maps, fotos, raw,
    place_id, descripcion_ia, score, fuente, estado, motivo_descarte, asignado_a, search_id,
    proxima_accion, proxima_tipo, intentos, no_contactar, client_ref, created_by
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19::jsonb,
    $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33
  )
  ON CONFLICT (place_id) WHERE place_id IS NOT NULL DO UPDATE SET ${MAPS_REFRESH}
  RETURNING ${LIST_COLS}, (xmax = 0) AS inserted`;

/**
 * POST /api/leads  -> array de leads o { leads: [...] }
 *
 * Deduplica por place_id y, si no hay coincidencia, por teléfono normalizado.
 * Los ids los genera el servidor (UUID); el id del navegador se guarda en
 * `client_ref` y se devuelve para que el frontend pueda enlazarlos.
 */
router.post(
  '/leads',
  ah(async (req, res) => {
    const body = req.body;
    const list: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.leads) ? body.leads : [];
    if (!list.length) {
      res.json({ saved: 0, inserted: 0, duplicates: 0, leads: [], errors: [] });
      return;
    }
    if (list.length > MAX_BATCH) throw new HttpError(413, `Máximo ${MAX_BATCH} leads por petición`);

    const user = req.user!;
    const errors: { index: number; client_ref: string | null; error: string }[] = [];
    const valid: { index: number; lead: LeadImport }[] = [];
    list.forEach((item, index) => {
      const { lead, error } = normalizeImport(item);
      if (lead) valid.push({ index, lead });
      else errors.push({ index, client_ref: optStr((item as { id?: unknown })?.id, 80), error: error || 'no válido' });
    });

    const out = await tx(async (c) => {
      const saved: Record<string, unknown>[] = [];
      for (const { lead: n } of valid) {
        // Un comercial solo puede crear leads asignados a sí mismo.
        if (!seesAll(user)) n.asignado_a = user.id;

        // Mismo place_id: es la misma ficha de Maps, se refrescan sus datos.
        if (n.place_id) {
          const r = await c.query('SELECT id FROM leads WHERE place_id = $1', [n.place_id]);
          if (r.rows.length) {
            const row = await refreshMaps(c, r.rows[0].id, n);
            saved.push({ ...row, client_ref: n.client_ref, duplicate: true });
            continue;
          }
        }
        // Mismo teléfono con otra ficha: es el mismo negocio, pero no se
        // mezclan datos de dos fichas distintas; se devuelve el existente.
        if (n.telefono_norm) {
          const r = await c.query(
            `SELECT ${LIST_COLS} FROM leads WHERE telefono_norm = $1 ORDER BY created_at LIMIT 1`,
            [n.telefono_norm]
          );
          if (r.rows.length) {
            saved.push({ ...r.rows[0], client_ref: n.client_ref, duplicate: true });
            continue;
          }
        }

        const r = await c.query(INSERT, [
          crypto.randomUUID(), ...mapsParams('', n).slice(1),
          n.place_id, n.descripcion_ia, n.score, n.fuente, n.estado, n.motivo_descarte,
          n.asignado_a, n.search_id, n.proxima_accion, n.proxima_tipo, n.intentos,
          n.no_contactar, n.client_ref, user.id
        ]);
        const { inserted, ...row } = r.rows[0];
        saved.push({ ...row, client_ref: n.client_ref, duplicate: !inserted });
      }
      return saved;
    });

    const duplicates = out.filter((l) => l.duplicate).length;
    res.json({
      saved: out.length,
      inserted: out.length - duplicates,
      duplicates,
      leads: out,
      errors
    });
  })
);

// --- Lectura ---------------------------------------------------------------

/**
 * GET /api/leads?estado=&asignado_a=&q=&ciudad=&sector=&no_contactar=&updated_since=&limit=&offset=
 * asignado_a=none devuelve los leads sin asignar.
 */
router.get(
  '/leads',
  ah(async (req, res) => {
    const q = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(String(q.limit || '100'), 10) || 100));
    const offset = Math.max(0, parseInt(String(q.offset || '0'), 10) || 0);
    const args: unknown[] = [];
    const where: string[] = [visibility(req.user, args)];
    const eq = (col: string, val: unknown) => {
      args.push(val);
      where.push(`${col} = $${args.length}`);
    };

    if (typeof q.estado === 'string' && q.estado) eq('estado', q.estado);
    if (typeof q.asignado_a === 'string' && q.asignado_a) {
      if (q.asignado_a === 'none') where.push('asignado_a IS NULL');
      else eq('asignado_a', q.asignado_a);
    }
    if (typeof q.ciudad === 'string' && q.ciudad) eq('ciudad', q.ciudad);
    if (typeof q.sector === 'string' && q.sector) eq('sector', q.sector);
    if (q.no_contactar === 'true' || q.no_contactar === 'false') eq('no_contactar', q.no_contactar === 'true');
    if (typeof q.updated_since === 'string' && q.updated_since) {
      const d = new Date(q.updated_since);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'updated_since no es una fecha válida');
      args.push(d.toISOString());
      where.push(`updated_at > $${args.length}`);
    }
    if (typeof q.q === 'string' && q.q.trim()) {
      const term = q.q.trim().slice(0, 100);
      args.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const p = `$${args.length}`;
      const tel = phoneNorm(term);
      let telCond = '';
      if (tel && tel.length >= 6) {
        args.push(`%${tel}%`);
        telCond = ` OR telefono_norm LIKE $${args.length}`;
      }
      where.push(`(nombre ILIKE ${p} OR ciudad ILIKE ${p} OR sector ILIKE ${p}${telCond})`);
    }

    args.push(limit, offset);
    const rows = await query<Record<string, unknown>>(
      `SELECT ${LIST_COLS}, count(*) OVER() AS total FROM leads
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const total = rows.length ? Number(rows[0].total) : 0;
    res.json({ leads: rows.map(({ total: _t, ...r }) => r), total, limit, offset });
  })
);

/** GET /api/leads/:id  (incluye `raw` y las interacciones) */
router.get(
  '/leads/:id',
  ah(async (req, res) => {
    const args: unknown[] = [req.params.id];
    const vis = visibility(req.user, args);
    const rows = await query(`SELECT * FROM leads WHERE id = $1 AND ${vis}`, args);
    if (!rows.length) throw new HttpError(404, 'Lead no encontrado');
    const interactions = await query(
      'SELECT * FROM lead_interactions WHERE lead_id = $1 ORDER BY fecha DESC LIMIT 200',
      [req.params.id]
    );
    res.json({ lead: rows[0], interactions });
  })
);

// --- Modificación ----------------------------------------------------------

/**
 * PATCH /api/leads/:id
 * Campos: estado, motivo_descarte, asignado_a, proxima_accion, proxima_tipo,
 * intentos, no_contactar, descripcion_ia, score, email, telefono.
 * Opcional `updated_at`: si el lead cambió desde entonces responde 409, así
 * dos comerciales no se pisan sin enterarse.
 */
router.patch(
  '/leads/:id',
  ah(async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const user = req.user!;

    const row = await tx(async (c) => {
      const cur = await loadVisible(c, req, req.params.id, true);

      if (b.updated_at !== undefined) {
        const exp = new Date(String(b.updated_at));
        if (Number.isNaN(exp.getTime())) throw new HttpError(400, '«updated_at» no es una fecha válida');
        if (Math.abs(new Date(cur.updated_at).getTime() - exp.getTime()) >= 1) {
          throw new HttpError(409, 'Otro usuario ha modificado este lead. Recárgalo antes de guardar.');
        }
      }

      const sets: string[] = [];
      const args: unknown[] = [];
      const add = (col: string, val: unknown) => {
        args.push(val);
        sets.push(`${col} = $${args.length}`);
      };

      let nuevoEstado: string | null = null;
      if ('estado' in b) {
        nuevoEstado = strictEnum(b, 'estado', ESTADOS_LEAD);
        add('estado', nuevoEstado);
      }
      if ('motivo_descarte' in b) add('motivo_descarte', strictStr(b, 'motivo_descarte', 300));
      if ('proxima_accion' in b) add('proxima_accion', strictDate(b, 'proxima_accion'));
      if ('proxima_tipo' in b) add('proxima_tipo', strictStr(b, 'proxima_tipo', 40));
      if ('intentos' in b) add('intentos', strictInt(b, 'intentos', 0, 1000) ?? 0);
      if ('descripcion_ia' in b) add('descripcion_ia', strictStr(b, 'descripcion_ia', 4000));
      if ('score' in b) add('score', strictInt(b, 'score', 0, 100));
      if ('email' in b) add('email', strictStr(b, 'email', 200));
      if ('telefono' in b) {
        const tel = strictStr(b, 'telefono', 40);
        add('telefono', tel);
        add('telefono_norm', phoneNorm(tel));
      }
      if ('no_contactar' in b) {
        const v = strictBool(b, 'no_contactar');
        if (!v && cur.no_contactar && !seesAll(user)) {
          throw new HttpError(403, 'Solo un admin o supervisor puede quitar «no contactar»');
        }
        add('no_contactar', v);
      }
      if ('asignado_a' in b) {
        const to = strictStr(b, 'asignado_a', 80);
        if (!seesAll(user)) {
          const libreOMio = cur.asignado_a === null || cur.asignado_a === user.id;
          if (!libreOMio || (to !== null && to !== user.id)) {
            throw new HttpError(403, 'Solo puedes asignarte leads libres a ti mismo');
          }
        }
        add('asignado_a', to);
      }
      if (!sets.length) throw new HttpError(400, 'Nada que actualizar');

      args.push(req.params.id);
      const r = await c.query(
        `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length} RETURNING ${LIST_COLS}`,
        args
      );

      if (nuevoEstado && nuevoEstado !== cur.estado) {
        await c.query(
          `INSERT INTO lead_interactions (id, lead_id, user_id, tipo, estado, nota)
           VALUES ($1, $2, $3, 'estado', $4, $5)`,
          [crypto.randomUUID(), req.params.id, user.id, nuevoEstado, `Estado: ${cur.estado} → ${nuevoEstado}`]
        );
      }
      return r.rows[0];
    });

    res.json({ lead: row });
  })
);

/**
 * DELETE /api/leads/:id  (solo admin)
 * Un lead marcado «no contactar» no se borra salvo con ?force=1: si se borra,
 * la próxima búsqueda lo volvería a traer como nuevo y se perdería la exclusión.
 */
router.delete(
  '/leads/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const rows = await query<{ no_contactar: boolean }>('SELECT no_contactar FROM leads WHERE id = $1', [
      req.params.id
    ]);
    if (!rows.length) throw new HttpError(404, 'Lead no encontrado');
    if (rows[0].no_contactar && req.query.force !== '1') {
      throw new HttpError(
        409,
        'Este lead está marcado «no contactar». Si lo borras, volverá a aparecer en futuras búsquedas. Usa ?force=1 para borrarlo igualmente.'
      );
    }
    await query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deleted: req.params.id });
  })
);

// --- Interacciones ---------------------------------------------------------

router.get(
  '/leads/:id/interactions',
  ah(async (req, res) => {
    const rows = await withClient(async (c) => {
      await loadVisible(c, req, req.params.id);
      const r = await c.query(
        'SELECT * FROM lead_interactions WHERE lead_id = $1 ORDER BY fecha DESC LIMIT 500',
        [req.params.id]
      );
      return r.rows;
    });
    res.json({ interactions: rows });
  })
);

/**
 * POST /api/leads/:id/interactions  { tipo, resultado?, nota?, estado? }
 * Una llamada suma un intento. Si viene `estado`, también actualiza el lead.
 */
router.post(
  '/leads/:id/interactions',
  ah(async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const tipo = strictEnum(b, 'tipo', TIPOS_INTERACCION);
    const resultado = 'resultado' in b ? strictStr(b, 'resultado', 80) : null;
    const nota = 'nota' in b ? strictStr(b, 'nota', 2000) : null;
    const estado = 'estado' in b && b.estado !== null ? strictEnum(b, 'estado', ESTADOS_LEAD) : null;

    const out = await tx(async (c) => {
      await loadVisible(c, req, req.params.id, true);
      const ins = await c.query(
        `INSERT INTO lead_interactions (id, lead_id, user_id, tipo, resultado, nota, estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [crypto.randomUUID(), req.params.id, req.user!.id, tipo, resultado, nota, estado]
      );
      const upd = await c.query(
        `UPDATE leads SET
           intentos = intentos + $2,
           estado = COALESCE($3, estado),
           updated_at = now()
         WHERE id = $1 RETURNING ${LIST_COLS}`,
        [req.params.id, tipo === 'llamada' ? 1 : 0, estado]
      );
      return { interaction: ins.rows[0], lead: upd.rows[0] };
    });
    res.status(201).json(out);
  })
);

export default router;
