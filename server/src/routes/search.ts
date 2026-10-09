import { Router, Request, Response } from 'express';
import { query, dbEnabled } from '../db';
import { runActor, ApifyError, ApifyRunBody } from '../apify';

const router = Router();

/**
 * POST /api/search
 * Proxy al actor de Apify. El token vive en el servidor (APIFY_TOKEN).
 * Body: { actor?, input?, params?, persist?, user_id? }
 * Responde: { items: [...rawDatasetItems] }
 */
router.post('/search', async (req: Request, res: Response) => {
  const body = (req.body || {}) as ApifyRunBody & { persist?: boolean; user_id?: string };
  try {
    const items = await runActor(body);

    if (body.persist && dbEnabled()) {
      const sector = body.params?.sector || null;
      const zona = body.params?.zona || null;
      await query(
        `INSERT INTO searches (id, user_id, sector, zona, estado, resultados, created_at)
         VALUES ($1, $2, $3, $4, 'completada', $5, now())
         ON CONFLICT (id) DO NOTHING`,
        [`s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, body.user_id || null, sector, zona, items.length]
      );
    }

    res.json({ items });
  } catch (e) {
    const err = e as ApifyError;
    if (err.name === 'ApifyError') {
      const status = err.status === 503 ? 503 : 502;
      res.status(status).json({ error: err.message });
      return;
    }
    const aborted = (e as Error)?.name === 'AbortError';
    res.status(aborted ? 504 : 500).json({ error: aborted ? 'tiempo de espera agotado' : 'error de red' });
  }
});

export default router;
