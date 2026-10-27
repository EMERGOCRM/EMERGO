import { Router } from 'express';
import { env, hasGoogle } from './env';
import { checkSignedValue, signValue } from './auth';
import { ah, HttpError } from './http';
import { isSocialUrl } from './validate';

/**
 * Motor de búsqueda con Google Places API (New) · Text Search.
 *
 * - Una petición devuelve hasta 20 negocios en 1–2 s; se piden hasta 3 páginas
 *   (60 resultados, el máximo que permite Google por consulta).
 * - Trae teléfono, web, valoración, hasta 5 reseñas y referencias de fotos:
 *   todo lo que necesitan la ficha y la demo, sin coste extra.
 * - Devuelve los resultados con la MISMA forma que el actor de Apify, así el
 *   frontend los procesa igual (title, phone, website, placeId, imageUrl…).
 */

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.photos',
  'places.reviews',
  'places.editorialSummary',
  'nextPageToken'
].join(',');

interface GPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  googleMapsUri?: string;
  businessStatus?: string;
  photos?: { name: string; widthPx?: number; heightPx?: number; authorAttributions?: { displayName?: string }[] }[];
  reviews?: {
    rating?: number;
    text?: { text?: string };
    originalText?: { text?: string };
    authorAttribution?: { displayName?: string };
    relativePublishTimeDescription?: string;
    publishTime?: string;
  }[];
  editorialSummary?: { text?: string };
}

export class GoogleError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApifyError'; // mismo tratamiento de errores que Apify en /api/search
    this.status = status;
  }
}

/** URL pública y firmada de una foto de Google (sirve el proxy de abajo). */
export function photoProxyPath(photoName: string, width = 1200): string {
  const name = Buffer.from(photoName).toString('base64url');
  const sig = signValue(`${photoName}|${width}`);
  return `/media/place-photo/${sig}/${width}/${name}.jpg`;
}

function component(p: GPlace, type: string, short = false): string {
  const c = (p.addressComponents || []).find((x) => (x.types || []).includes(type));
  return (short ? c?.shortText : c?.longText) || '';
}

export function placeToItem(p: GPlace): Record<string, unknown> {
  const photos = (p.photos || []).slice(0, 8);
  const web = p.websiteUri || '';
  return {
    placeId: p.id,
    title: p.displayName?.text || '',
    categoryName: p.primaryTypeDisplayName?.text || '',
    categories: p.types || [],
    address: p.formattedAddress || '',
    city: component(p, 'locality') || component(p, 'administrative_area_level_2'),
    postalCode: component(p, 'postal_code'),
    countryCode: component(p, 'country', true),
    location: { lat: p.location?.latitude, lng: p.location?.longitude },
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    phoneUnformatted: p.internationalPhoneNumber || '',
    website: web,
    // Si la "web" es una red social, el frontend la trata como red, no como web propia.
    socialFromWebsite: isSocialUrl(web),
    totalScore: p.rating ?? null,
    reviewsCount: p.userRatingCount ?? 0,
    openingHours: p.regularOpeningHours?.weekdayDescriptions || [],
    url: p.googleMapsUri || '',
    permanentlyClosed: p.businessStatus === 'CLOSED_PERMANENTLY',
    temporarilyClosed: p.businessStatus === 'CLOSED_TEMPORARILY',
    description: p.editorialSummary?.text || '',
    imageUrl: photos[0] ? photoProxyPath(photos[0].name) : null,
    imageUrls: photos.map((ph) => photoProxyPath(ph.name)),
    reviews: (p.reviews || []).map((r) => ({
      stars: r.rating ?? null,
      text: r.originalText?.text || r.text?.text || '',
      name: r.authorAttribution?.displayName || '',
      publishAt: r.relativePublishTimeDescription || '',
      publishedAtDate: r.publishTime || ''
    })),
    source: 'google_places'
  };
}

async function searchPage(textQuery: string, pageToken?: string): Promise<{ places: GPlace[]; next?: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), env.googleTimeoutMs);
  try {
    const res = await fetch(`${env.googleApi}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googleMapsKey.trim(),
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify({
        textQuery,
        languageCode: 'es',
        regionCode: 'ES',
        pageSize: 20,
        ...(pageToken ? { pageToken } : {})
      }),
      signal: ctrl.signal
    });
    const body = (await res.json().catch(() => ({}))) as {
      places?: GPlace[];
      nextPageToken?: string;
      error?: { message?: string; status?: string };
    };
    if (!res.ok) {
      const msg = body.error?.message || `HTTP ${res.status}`;
      throw new GoogleError(`Google Places: ${msg}`, res.status === 403 ? 403 : res.status === 429 ? 429 : res.status);
    }
    return { places: body.places || [], next: body.nextPageToken };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Busca negocios. `max` se reparte en páginas de 20 (máx. 60 por consulta).
 * Los cerrados definitivamente se descartan aquí.
 */
export async function googleSearch(params: { sector?: string; zona?: string; max?: number }): Promise<unknown[]> {
  if (!hasGoogle()) throw new GoogleError('GOOGLE_MAPS_API_KEY no configurada en el servidor', 503);
  const zona = params.zona && params.zona !== 'Toda España' ? params.zona : 'España';
  const textQuery = `${params.sector || 'negocios'} en ${zona}`;
  const max = Math.max(1, Math.min(60, params.max || 60));

  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 3 && items.length < max; page++) {
    const { places, next } = await searchPage(textQuery, token);
    for (const p of places) {
      if (seen.has(p.id) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      seen.add(p.id);
      items.push(placeToItem(p));
    }
    if (!next) break;
    token = next;
    // Google exige una breve espera antes de poder usar el siguiente token.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return items.slice(0, max);
}

// --- Proxy público de fotos ------------------------------------------------

const cache = new Map<string, { body: Buffer; type: string; at: number }>();
const CACHE_MAX = 300;

/**
 * GET /media/place-photo/:sig/:width/:name.jpg
 * Sirve la foto sin exponer la clave de Google. La firma impide usar el proxy
 * para otras fotos. Cada foto nueva cuesta una llamada a Place Photos, por eso
 * se guarda en memoria y el navegador la cachea 7 días. Termina en .jpg para
 * que herramientas como Lovable la acepten como imagen de referencia.
 */
export const mediaRouter = Router();

mediaRouter.get(
  '/media/place-photo/:sig/:width/:name.jpg',
  ah(async (req, res) => {
    const width = Math.max(200, Math.min(1600, parseInt(req.params.width, 10) || 1200));
    let photoName = '';
    try {
      photoName = Buffer.from(req.params.name, 'base64url').toString('utf8');
    } catch {
      throw new HttpError(400, 'Foto no válida');
    }
    if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(photoName) || !checkSignedValue(`${photoName}|${width}`, req.params.sig)) {
      throw new HttpError(403, 'Firma no válida');
    }
    if (!hasGoogle()) throw new HttpError(503, 'Fotos de Google no configuradas');

    const key = `${photoName}|${width}`;
    let hit = cache.get(key);
    if (!hit) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), env.googleTimeoutMs);
      try {
        const r = await fetch(
          `${env.googleApi}/${photoName}/media?maxWidthPx=${width}&key=${encodeURIComponent(env.googleMapsKey.trim())}`,
          { signal: ctrl.signal }
        );
        if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'No se pudo obtener la foto');
        hit = { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg', at: Date.now() };
      } finally {
        clearTimeout(to);
      }
      cache.set(key, hit);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    }
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(hit.body);
  })
);
