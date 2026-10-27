import crypto from 'crypto';
import { Router } from 'express';
import { query } from '../db';
import { runActor, ApifyError } from '../apify';
import { ah, HttpError, makeRateLimiter } from '../http';
import { optInt, optStr } from '../validate';
import { configuredActor } from './config';
import { googleSearch } from '../places';
import { activeProvider, hasApifyToken, hasGoogle } from '../env';

const router = Router();

// La cobertura por provincias lanza hasta 52 búsquedas seguidas.
const searchLimit = makeRateLimiter(10 * 60 * 1000);

/**
 * POST /api/search
 * Body: { params: { sector, zona, max }, sinWeb?, persist?, provider? }
 *
 * provider: 'google' (Places API, rápido) o 'apify'. Si no se indica, se usa
 * el configurado en el servidor (SEARCH_PROVIDER).
 *
 * El actor y el input los decide SIEMPRE el servidor: se ignoran `actor` e
 * `input` del cliente para que nadie pueda ejecutar otros actores con tu token.
 */
router.post(
  '/search',
  ah(async (req, res) => {
    const user = req.user!;
    if (!searchLimit(`u:${user.id}`, 120)) {
      throw new HttpError(429, 'Demasiadas búsquedas seguidas. Espera unos minutos.');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const p = (body.params || {}) as Record<string, unknown>;
    const params = {
      sector: optStr(p.sector, 120) || undefined,
      zona: optStr(p.zona, 120) || undefined,
      max: optInt(p.max, 1, 120) ?? 60
    };
    const wanted = optStr(body.provider, 20);
    const provider = wanted === 'google' || wanted === 'apify' ? wanted : activeProvider();
    if (provider === 'google' && !hasGoogle()) throw new HttpError(503, 'Google Places no está configurado (GOOGLE_MAPS_API_KEY)');
    if (provider === 'apify' && !hasApifyToken()) throw new HttpError(503, 'Apify no está configurado (APIFY_TOKEN)');

    try {
      const started = Date.now();
      const items =
        provider === 'google'
          ? await googleSearch(params)
          : await runActor({ actor: await configuredActor(), params, sinWeb: body.sinWeb !== false });

      if (body.persist) {
        await query(
          `INSERT INTO searches (id, user_id, sector, zona, estado, resultados, created_at)
           VALUES ($1, $2, $3, $4, 'completada', $5, now())`,
          [`s_${crypto.randomUUID()}`, user.id, params.sector || null, params.zona || null, items.length]
        );
      }
      res.json({ items, provider, ms: Date.now() - started });
    } catch (e) {
      const err = e as ApifyError;
      if (err.name === 'ApifyError') {
        const keep = [400, 401, 402, 403, 404, 409, 422, 429];
        const status = err.status === 503 ? 503 : keep.includes(err.status) ? err.status : 502;
        res.status(status).json({ error: err.message });
        return;
      }
      if ((e as Error)?.name === 'AbortError') {
        res.status(504).json({ error: 'tiempo de espera agotado' });
        return;
      }
      throw e;
    }
  })
);

export default router;
