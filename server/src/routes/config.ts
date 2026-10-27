import { Router } from 'express';
import { env, hasApifyToken, hasGoogle, activeProvider, hasDemoAI } from '../env';
import { checkApify } from '../apify';
import { dbEnabled, query } from '../db';
import { ah, HttpError } from '../http';
import { requireRole } from '../auth';

const router = Router();

const ACTOR_RE = /^[\w.-]{1,100}[/~][\w.-]{1,100}$/;

/** Actor de Apify en uso: el guardado en `settings` o el de la variable de entorno. */
export async function configuredActor(): Promise<string> {
  try {
    if (dbEnabled()) {
      const rows = await query<{ value: { actor?: string } }>(
        "SELECT value FROM settings WHERE key = 'apify' LIMIT 1"
      );
      const stored = rows[0]?.value?.actor;
      if (stored && ACTOR_RE.test(stored)) return stored;
    }
  } catch {
    /* la BD puede no estar lista; seguimos con el valor por defecto */
  }
  return env.apifyActor;
}

/**
 * GET /api/config
 * Devuelve SOLO configuración pública (nunca el token de Apify).
 */
router.get(
  '/config',
  ah(async (_req, res) => {
    res.json({
      ok: true,
      apify: { configured: hasApifyToken(), actor: await configuredActor() },
      google: { configured: hasGoogle() },
      provider: activeProvider(),
      demos: { configured: hasDemoAI() },
      db: { configured: dbEnabled() },
      sources: ['Google Places', 'Outscraper', 'SerpApi', 'Apify', 'OpenStreetMap', 'Foursquare']
    });
  })
);

/**
 * PUT /api/config  (solo admin)
 * Actualiza ajustes no secretos (el actor de Apify) en la tabla settings.
 */
router.put(
  '/config',
  requireRole('admin'),
  ah(async (req, res) => {
    const actor = String(req.body?.apify?.actor || req.body?.actor || '').trim() || env.apifyActor;
    if (!ACTOR_RE.test(actor)) throw new HttpError(400, 'Actor no válido. Formato: usuario/nombre-actor');
    const value = { actor };
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('apify', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(value)]
    );
    res.json({ ok: true, apify: value });
  })
);

/**
 * GET /api/apify/status
 * Comprueba contra Apify que el token del servidor y el actor configurado son
 * válidos. No ejecuta el actor ni consume créditos, y nunca devuelve el token.
 */
router.get(
  '/apify/status',
  ah(async (_req, res) => {
    const status = await checkApify(await configuredActor());
    res.json({ ok: status.valid, ...status });
  })
);

export default router;
