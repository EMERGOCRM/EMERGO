import { Router, Request, Response } from 'express';
import { aiChat, aiConfigured, researchBrief, researchPages } from '../ai';
import { env } from '../env';

const router = Router();

const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 10 * 60 * 1000;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit(req: Request, res: Response, max: number): boolean {
  const now = Date.now();
  const key = clientIp(req);
  const cur = hits.get(key);
  if (!cur || cur.reset <= now) {
    hits.set(key, { count: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (cur.count >= max) {
    res.status(429).json({ error: 'Demasiadas peticiones de IA. Espera unos minutos.' });
    return false;
  }
  cur.count += 1;
  return true;
}

/**
 * GET /api/ai/status
 * Indica si el servidor tiene IA configurada y qué modelo usa. Nunca expone la clave.
 */
router.get('/ai/status', (_req: Request, res: Response) => {
  res.json({ ok: true, configured: aiConfigured(), model: aiConfigured() ? env.openaiModel : null });
});

/**
 * POST /api/ai
 * Genera el copy JSON de una demo a partir del prompt del brief.
 * Body: { prompt: string }
 */
router.post('/ai', async (req: Request, res: Response) => {
  if (!aiConfigured()) {
    res.status(503).json({ error: 'IA no configurada en el servidor (OPENAI_API_KEY)' });
    return;
  }
  if (!rateLimit(req, res, 30)) return;
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'Falta el prompt' });
    return;
  }
  if (prompt.length > 20000) {
    res.status(413).json({ error: 'El prompt supera el límite de 20.000 caracteres' });
    return;
  }
  try {
    const content = await aiChat([
      {
        role: 'system',
        content:
          'Eres un director creativo y copywriter español especializado en webs para pequeños negocios locales. ' +
          'Devuelve SOLO JSON válido, sin markdown ni explicaciones, respetando el esquema pedido. ' +
          'No inventes datos verificables: si falta un dato usa "[POR CONFIRMAR]".'
      },
      { role: 'user', content: `${prompt}\n\nDevuelve exactamente el JSON del brief solicitado.` }
    ]);
    res.json({ ok: true, content });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

/**
 * POST /api/enrich
 * Descarga hasta 3 enlaces públicos del negocio y resume su contenido.
 * Body: { urls: string[], nombre?: string, ciudad?: string }
 */
router.post('/enrich', async (req: Request, res: Response) => {
  if (!rateLimit(req, res, 20)) return;
  const raw = req.body?.urls;
  if (!Array.isArray(raw) || !raw.length) {
    res.status(400).json({ error: 'Faltan los enlaces a analizar' });
    return;
  }
  const urls = raw
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 3);
  if (!urls.length) {
    res.status(400).json({ error: 'Ningún enlace es http o https' });
    return;
  }
  const nombre = String(req.body?.nombre || '').slice(0, 160);
  const ciudad = String(req.body?.ciudad || '').slice(0, 120);
  try {
    const { items, errors } = await researchPages(urls);
    if (!items.length) {
      res.status(422).json({ error: `No se pudo analizar ningún enlace. ${errors.join(' · ')}` });
      return;
    }
    const text = await researchBrief(nombre, ciudad, items);
    res.json({
      ok: true,
      text,
      items: items.map((i) => ({ url: i.finalUrl, title: i.title, description: i.description })),
      errors
    });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
