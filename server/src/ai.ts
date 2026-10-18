import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { env, hasAI } from './env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PageInfo {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  text: string;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data'
]);

function privateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return true;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('fe80')) return true;
    if (low.startsWith('::ffff:')) return privateIp(low.slice(7));
    return false;
  }
  return true;
}

async function publicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('URL no válida');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Solo se permiten enlaces http o https');
  }
  if (u.username || u.password) throw new Error('La URL no puede llevar credenciales');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Destino no permitido');
  }
  let addrs: { address: string }[] = [];
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    addrs = Array.isArray(found) ? found : [found];
  } catch {
    throw new Error('No se pudo resolver el dominio');
  }
  if (!addrs.length) throw new Error('No se pudo resolver el dominio');
  if (addrs.some((a) => privateIp(a.address))) throw new Error('Destino no permitido');
  return u;
}

function normalizeBase(base: string): string {
  return String(base || '').trim().replace(/\/+$/, '');
}

export function aiConfigured(): boolean {
  return hasAI();
}

export async function aiChat(messages: ChatMessage[], temperature = 0.6): Promise<string> {
  if (!hasAI()) throw new Error('IA no configurada en el servidor (OPENAI_API_KEY)');
  const base = normalizeBase(env.openaiBaseUrl) || 'https://api.openai.com/v1';
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.aiTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openaiApiKey}`
      },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature,
        messages
      }),
      signal: controller.signal
    });
    const raw = await res.text();
    let data: {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    } = {};
    try {
      data = JSON.parse(raw);
    } catch {
      /* respuesta no JSON */
    }
    if (!res.ok) {
      throw new Error(data.error?.message || `El proveedor de IA devolvió HTTP ${res.status}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content || !String(content).trim()) throw new Error('La IA devolvió una respuesta vacía');
    return String(content);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('La IA tardó demasiado en responder');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const UA = 'DigitalizaCRM/1.1 (+investigación pública de negocios)';
const MAX_BYTES = 450_000;

async function fetchPage(raw: string): Promise<PageInfo> {
  let url = await publicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.6'
        }
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      url = await publicUrl(new URL(loc, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error('No se pudo descargar el enlace');
  if (!res.ok) throw new Error(`El enlace devolvió HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error('El enlace no es una página web');

  let html = '';
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    html += decoder.decode();
  } else {
    html = await res.text();
  }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 200);
  let description = '';
  const m1 = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const m2 = html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const m3 = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  description = decode((m1 || m2 || m3 || [])[1] || '').slice(0, 350);

  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);

  return { url: raw, finalUrl: url.toString(), title, description, text };
}

function decode(s: string): string {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

export async function researchPages(urls: string[]): Promise<{ items: PageInfo[]; errors: string[] }> {
  const items: PageInfo[] = [];
  const errors: string[] = [];
  for (const u of urls.slice(0, 3)) {
    try {
      items.push(await fetchPage(u));
    } catch (e) {
      errors.push(`${u}: ${(e as Error).message}`);
    }
  }
  return { items, errors };
}

export async function researchBrief(nombre: string, ciudad: string, pages: PageInfo[]): Promise<string> {
  if (!pages.length) return '';
  if (!hasAI()) {
    return pages
      .map((p) => `${p.finalUrl}\n${p.title}${p.description ? ` — ${p.description}` : ''}\n${p.text.slice(0, 900)}`)
      .join('\n\n');
  }
  const corpus = pages
    .map((p) => `URL: ${p.finalUrl}\nTÍTULO: ${p.title}\nDESCRIPCIÓN: ${p.description}\nTEXTO: ${p.text.slice(0, 2600)}`)
    .join('\n\n---\n\n');
  return aiChat(
    [
      {
        role: 'system',
        content:
          'Eres un analista de investigación de mercados en España. Resumes solo lo que aparece en las fuentes. No inventas datos. Escribes en español, en texto plano, con hechos verificables y sin marketing.'
      },
      {
        role: 'user',
        content:
          `Negocio: ${nombre || 'sin nombre'} (${ciudad || 'España'}).\n\n` +
          `Analiza estas fuentes públicas y devuelve un informe breve con: 1) qué hace el negocio y especialidades; 2) tono y mensajes que usa; 3) servicios/productos citados; 4) horarios, dirección y contacto si aparecen; 5) huecos evidentes para una web (sin inventar). ` +
          `Señala con [POR CONFIRMAR] cualquier dato dudoso.\n\n${corpus}`
      }
    ],
    0.2
  );
}
