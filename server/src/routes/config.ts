import { Router, Request, Response } from 'express';
import { env, hasApifyToken } from '../env';
import { dbEnabled, query } from '../db';

const router = Router();

/**
 * GET /api/config
 * Devuelve SOLO configuración pública (nunca el token de Apify).
 */
router.get('/config', async (_req: Request, res: Response) => {
  let actor = env.apifyActor;
  try {
    if (dbEnabled()) {
      const rows = await query<{ value: { actor?: string } }>(
        "SELECT value FROM settings WHERE key = 'apify' LIMIT 1"
      );
      if (rows.length && rows[0].value?.actor) actor = rows[0].value.actor;
    }
  } catch {
    /* la BD puede no estar lista; seguimos con el valor por defecto */
  }

  res.json({
    ok: true,
    apify: { configured: hasApifyToken(), actor },
    db: { configured: dbEnabled() },
    sources: ['Google Places', 'Outscraper', 'SerpApi', 'Apify', 'OpenStreetMap', 'Foursquare']
  });
});

/**
 * PUT /api/config
 * Actualiza ajustes no secretos (p. ej. el actor de Apify) en la tabla settings.
 */
router.put('/config', async (req: Request, res: Response) => {
  if (!dbEnabled()) {
    res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL)' });
    return;
  }
  const actor = String(req.body?.apify?.actor || req.body?.actor || '').trim();
  const value = { actor: actor || env.apifyActor };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('apify', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)]
  );
  res.json({ ok: true, apify: value });
});

export default router;
