import { Router } from 'express';
import { query } from '../db';
import { tx } from './leads';
import { ah, HttpError } from '../http';
import { seesAll } from '../auth';
import { optDate, optInt, optStr } from '../validate';

/**
 * Historial de búsquedas. Cada búsqueda que se lanza desde el CRM queda
 * guardada con sus parámetros, el proveedor, el resultado y los leads que trajo.
 */
const router = Router();

function json(v: unknown, max = 20000): string | null {
  if (v === undefined || v === null) return null;
  try {
    const s = JSON.stringify(v);
    return s.length <= max ? s : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/searches  { searches: [{ id, sector, zona, radio, estado, resultados,
 *   nuevos, duplicados, programada, proveedor, params, stats, lead_ids, fecha }] }
 * Upsert por id (el id lo genera el navegador). Idempotente.
 */
router.post(
  '/searches',
  ah(async (req, res) => {
    const list = Array.isArray(req.body?.searches) ? req.body.searches : Array.isArray(req.body) ? req.body : [];
    if (list.length > 500) throw new HttpError(413, 'Máximo 500 búsquedas por petición');
    const user = req.user!;
    const saved: string[] = [];
    for (const raw of list) {
      const s = (raw || {}) as Record<string, unknown>;
      const id = optStr(s.id, 80);
      if (!id) continue;
      const leadIds = Array.isArray(s.lead_ids ?? s.leadIds)
        ? ((s.lead_ids ?? s.leadIds) as unknown[]).map((x) => optStr(x, 80)).filter(Boolean).slice(0, 5000)
        : [];
      // Un usuario no puede sobrescribir la búsqueda de otro (salvo admin/supervisor).
      const r = await query(
        `INSERT INTO searches (id, user_id, sector, zona, radio, estado, resultados, nuevos, duplicados,
                               programada, proveedor, params, stats, lead_ids, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,COALESCE($15::timestamptz, now()), now())
         ON CONFLICT (id) DO UPDATE SET
           estado = EXCLUDED.estado, resultados = EXCLUDED.resultados, nuevos = EXCLUDED.nuevos,
           duplicados = EXCLUDED.duplicados, programada = EXCLUDED.programada,
           stats = COALESCE(EXCLUDED.stats, searches.stats),
           lead_ids = EXCLUDED.lead_ids, updated_at = now()
         WHERE searches.user_id = $2 OR $16
         RETURNING id`,
        [
          id, user.id, optStr(s.sector, 120), optStr(s.zona, 160), optInt(s.radio), optStr(s.estado, 40) || 'completada',
          optInt(s.resultados) ?? 0, optInt(s.nuevos) ?? 0, optInt(s.duplicados) ?? 0, optStr(s.programada, 40),
          optStr(s.proveedor, 40), json(s.params), json(s.stats), JSON.stringify(leadIds),
          optDate(s.fecha ?? s.created_at), seesAll(user)
        ]
      );
      if (r.length) saved.push(id);
    }
    res.json({ saved });
  })
);

/** GET /api/searches?limit=  — admin/supervisor ven todas; el resto, las suyas. */
router.get(
  '/searches',
  ah(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '300'), 10) || 300));
    const user = req.user!;
    const rows = seesAll(user)
      ? await query('SELECT * FROM searches ORDER BY created_at DESC LIMIT $1', [limit])
      : await query('SELECT * FROM searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [user.id, limit]);
    res.json({ searches: rows });
  })
);

/** Solo quien lanzó la búsqueda (o admin/supervisor) puede deshacerla o borrarla. */
async function checkOwner(user: { id: string; rol: string }, id: string): Promise<{ exists: boolean }> {
  const rows = await query<{ user_id: string | null }>('SELECT user_id FROM searches WHERE id = $1', [id]);
  if (rows.length && rows[0].user_id !== user.id && !seesAll(user as never)) {
    throw new HttpError(403, 'Solo quien lanzó la búsqueda o un admin puede modificarla');
  }
  return { exists: rows.length > 0 };
}

/**
 * POST /api/searches/:id/undo
 * Deshace una búsqueda: borra los leads que trajo SIN TRABAJAR y la quita del
 * historial. Se conservan los que ya tienen gestión (estado distinto de
 * «nuevo», llamadas o notas, intentos, demos o «no contactar»), y los que ya
 * existían antes (esos pertenecen a otra búsqueda).
 */
router.post(
  '/searches/:id/undo',
  ah(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;
    await checkOwner(user, id);
    const out = await tx(async (c) => {
      const args: unknown[] = [id];
      let own = '';
      if (!seesAll(user)) {
        args.push(user.id);
        own = ` AND l.created_by = $${args.length}`;
      }
      const r = await c.query(
        `SELECT l.id, l.nombre, l.estado, l.intentos, l.no_contactar,
                EXISTS (SELECT 1 FROM lead_interactions i WHERE i.lead_id = l.id AND COALESCE(i.user_id,'') <> 'system') AS trabajado,
                EXISTS (SELECT 1 FROM demos d WHERE d.lead_id = l.id) AS con_demo
           FROM leads l WHERE l.search_id = $1${own} FOR UPDATE`,
        args
      );
      const deleted: string[] = [];
      const kept: { id: string; nombre: string; motivo: string }[] = [];
      for (const l of r.rows) {
        const motivo =
          l.no_contactar ? 'marcado «no contactar»'
          : l.estado !== 'nuevo' ? `estado «${l.estado}»`
          : l.intentos > 0 ? 'tiene llamadas'
          : l.trabajado ? 'tiene notas o llamadas'
          : l.con_demo ? 'tiene demo'
          : '';
        if (motivo) kept.push({ id: l.id, nombre: l.nombre, motivo });
        else deleted.push(l.id);
      }
      if (deleted.length) await c.query('DELETE FROM leads WHERE id = ANY($1::text[])', [deleted]);
      // Los conservados dejan de colgar de una búsqueda que ya no existe.
      if (kept.length) await c.query('UPDATE leads SET search_id = NULL, updated_at = now() WHERE id = ANY($1::text[])', [kept.map((k) => k.id)]);
      await c.query('DELETE FROM searches WHERE id = $1', [id]);
      return { deleted, kept };
    });
    res.json({ ok: true, ...out });
  })
);

/** DELETE /api/searches/:id — quita la búsqueda del historial (los leads se quedan). */
router.delete(
  '/searches/:id',
  ah(async (req, res) => {
    const user = req.user!;
    await checkOwner(user, req.params.id);
    await query('DELETE FROM searches WHERE id = $1', [req.params.id]);
    await query('UPDATE leads SET search_id = NULL, updated_at = now() WHERE search_id = $1', [req.params.id]);
    res.json({ ok: true });
  })
);

export default router;
