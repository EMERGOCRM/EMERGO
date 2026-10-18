import { Router, Request, Response } from 'express';
import { env, hasApifyToken } from '../env';
import { checkApify } from '../apify';
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
      const stored = rows.length ? rows[0].value?.actor : undefined;
      if (stored) actor = stored;
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

/**
 * GET /api/apify/status
 * Comprueba contra Apify que el token del servidor y el actor son válidos.
 * No ejecuta el actor ni consume créditos de búsqueda, y nunca devuelve el token.
 */
router.get('/apify/status', async (req: Request, res: Response) => {
  const actor = typeof req.query.actor === 'string' ? req.query.actor : undefined;
  const status = await checkApify(actor);
  res.json({ ok: status.valid, ...status });
});

export default router;
