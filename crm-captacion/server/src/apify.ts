import { env, hasApifyToken } from './env';

export interface SearchParams {
  sector?: string;
  zona?: string;
  max?: number;
}

export interface ApifyRunBody {
  actor?: string;
  input?: Record<string, unknown>;
  params?: SearchParams;
}

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

export function hasOwnWeb(u: unknown): boolean {
  return !!u && !isSocialUrl(u);
}

export function buildApifyInput(params: SearchParams, limit: number, sinWeb = true): Record<string, unknown> {
  const zona = params.zona && params.zona !== 'Toda España' ? params.zona : '';
  const yaEspana = /espa(ñ|n)a|spain/i.test(zona);
  const locationQuery = zona ? (yaEspana ? zona : `${zona}, España`) : 'España';
  const q = `${params.sector || 'negocios'}${zona ? ` ${zona}` : ' España'}`;

  const input: Record<string, unknown> = {
    searchStringsArray: [q],
    searchString: q,
    countryCode: 'es',
    locationQuery,
    city: zona,
    maxCrawledPlacesPerSearch: limit,
    maxResults: limit,
    maxItems: limit,
    language: 'es',
    skipClosedPlaces: true,
    scrapePlaceDetailPage: false
  };
  if (sinWeb !== false) input.website = 'withoutWebsite';
  return input;
}

export class ApifyError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ApifyError';
    this.status = status;
    this.body = body;
  }
}

async function postRun(actorPath: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const url =
    `${env.apifyApi}/acts/${encodeURIComponent(actorPath)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(env.apifyToken.trim())}&timeout=180&format=json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = '';
    try {
      const j = JSON.parse(body);
      msg = (j && j.error && j.error.message) || '';
    } catch {
      msg = String(body || '').slice(0, 180);
    }
    throw new ApifyError(`HTTP ${res.status}${msg ? ` · ${msg}` : ''}`, res.status, msg);
  }
  return res.json();
}

/**
 * Ejecuta el actor de Apify en modo síncrono y devuelve el dataset.
 * Replica el reintento del cliente: si Apify rechaza el filtro `website`
 * (HTTP 400), se reintenta una vez sin él.
 */
export async function runActor(body: ApifyRunBody): Promise<unknown[]> {
  if (!hasApifyToken()) {
    throw new ApifyError('Apify token no configurado en el servidor', 503, 'APIFY_TOKEN missing');
  }

  const actor = String(body.actor || env.apifyActor).trim();
  const actorPath = actor.includes('/') ? actor.replace('/', '~') : actor;
  const limit = Math.max(1, Math.min(120, body.params?.max || 60));
  const baseInput = body.input || buildApifyInput(body.params || {}, limit, true);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), env.apifyTimeoutMs);

  try {
    let data: unknown;
    try {
      data = await postRun(actorPath, baseInput, ctrl.signal);
    } catch (e) {
      const err = e as ApifyError;
      if (err.status === 400 && /website/i.test(err.body || '')) {
        const retryInput = { ...baseInput };
        delete (retryInput as { website?: unknown }).website;
        data = await postRun(actorPath, retryInput, ctrl.signal);
      } else {
        throw e;
      }
    }
    if (Array.isArray(data)) return data;
    const items = (data as { items?: unknown[] })?.items;
    return Array.isArray(items) ? items : [];
  } finally {
    clearTimeout(to);
  }
}
