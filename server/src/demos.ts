import crypto from 'crypto';
import { Router, Request } from 'express';
import { env, hasDemoAI } from './env';
import { query } from './db';
import { ah, HttpError, makeRateLimiter } from './http';
import { researchPages } from './ai';
import { isSocialUrl, optStr } from './validate';
import { visibility } from './routes/leads';

/**
 * Demos para enseñar al cliente.
 *
 *  - Web: la genera una IA a partir de TODO lo que sabemos del negocio
 *    (ficha de Maps, reseñas reales, fotos reales, horario, redes y lo que
 *    haya en sus enlaces públicos). Se publica en /demo/<slug>.
 *  - CRM: plantilla profesional personalizada con el negocio (sin IA: es
 *    rápida, gratis y siempre se ve bien).
 *
 * Las demos se sirven con `Content-Security-Policy: sandbox`, así el HTML
 * generado se ejecuta en un origen aislado y nunca puede leer la sesión del CRM.
 */

export const demosApi = Router();
export const demosPublic = Router();

const genLimit = makeRateLimiter(60 * 60 * 1000);

// --- Contexto del negocio --------------------------------------------------

interface Review {
  stars: number | null;
  text: string;
  name: string;
  when: string;
}

interface DemoContext {
  lead: Record<string, unknown>;
  nombre: string;
  sector: string;
  ciudad: string;
  direccion: string;
  telefono: string;
  email: string;
  rating: number | null;
  resenas: number;
  maps: string;
  horario: string[];
  descripcion: string;
  categorias: string[];
  reviews: Review[];
  photos: string[];
  socials: string[];
  research: string;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function absolute(base: string, u: string): string {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('/')) return base + u;
  return '';
}

function publicBase(req: Request): string {
  if (env.publicUrl.trim()) return env.publicUrl.trim().replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function socialUrlsFromRaw(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    const s = str(u);
    if (/^https?:\/\//.test(s) && !out.includes(s)) out.push(s);
  };
  for (const k of ['instagrams', 'facebooks', 'tiktoks', 'youtubes', 'twitters', 'linkedIns', 'linkedins']) {
    asArray(raw[k]).forEach(push);
  }
  const sp = raw.socialProfiles;
  if (Array.isArray(sp)) sp.forEach((s) => push((s as { url?: string })?.url || s));
  if (isSocialUrl(raw.website)) push(raw.website);
  return out.slice(0, 5);
}

function reviewsFromRaw(raw: Record<string, unknown>): Review[] {
  return asArray(raw.reviews)
    .map((r) => {
      const o = (r || {}) as Record<string, unknown>;
      return {
        stars: typeof o.stars === 'number' ? o.stars : typeof o.rating === 'number' ? o.rating : null,
        text: str(o.text ?? o.textTranslated ?? (o.originalText as { text?: string })?.text).slice(0, 700),
        name: str(o.name ?? o.author ?? (o.authorAttribution as { displayName?: string })?.displayName),
        when: str(o.publishAt ?? o.relativePublishTimeDescription)
      };
    })
    .filter((r) => r.text.length > 15)
    .slice(0, 8);
}

function hoursFromRaw(raw: Record<string, unknown>, fallback: string): string[] {
  const oh = asArray(raw.openingHours);
  const lines = oh
    .map((h) => {
      if (typeof h === 'string') return h;
      const o = (h || {}) as { day?: string; hours?: string };
      return o.day ? `${o.day}: ${o.hours || ''}` : '';
    })
    .filter(Boolean)
    .slice(0, 7);
  return lines.length ? lines : fallback ? [fallback] : [];
}

/** Nombre de pila + inicial: suficiente para la demo, sin exponer al autor. */
function shortName(n: string): string {
  const parts = n.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Cliente de Google';
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
}

async function buildContext(req: Request, leadId: string, analyse: boolean): Promise<DemoContext> {
  const args: unknown[] = [leadId];
  const vis = visibility(req.user, args);
  const rows = await query<Record<string, unknown>>(`SELECT * FROM leads WHERE id = $1 AND ${vis}`, args);
  if (!rows.length) throw new HttpError(404, 'Lead no encontrado');
  const l = rows[0];
  const raw = (l.raw && typeof l.raw === 'object' ? l.raw : {}) as Record<string, unknown>;
  const base = publicBase(req);

  const photos: string[] = [];
  const addPhoto = (u: unknown) => {
    const a = absolute(base, str(u));
    if (a && !photos.includes(a)) photos.push(a);
  };
  addPhoto(l.image_url);
  asArray(raw.imageUrls).forEach(addPhoto);
  asArray(raw.images).forEach((i) => addPhoto(typeof i === 'string' ? i : (i as { imageUrl?: string })?.imageUrl));
  addPhoto(raw.imageUrl);
  asArray(l.fotos).forEach(addPhoto);

  const socials = socialUrlsFromRaw(raw);
  let research = '';
  if (analyse && socials.length) {
    try {
      const { items } = await researchPages(socials.slice(0, 3));
      research = items
        .map((p) => `- ${p.finalUrl}\n  Título: ${p.title}\n  Descripción: ${p.description}\n  Texto: ${p.text.slice(0, 1200)}`)
        .join('\n');
    } catch {
      /* los enlaces públicos son un extra: si fallan, seguimos */
    }
  }

  return {
    lead: l,
    nombre: str(l.nombre),
    sector: str(l.sector) || 'Negocio local',
    ciudad: str(l.ciudad),
    direccion: str(l.direccion),
    telefono: str(l.telefono),
    email: str(l.email),
    rating: l.rating === null || l.rating === undefined ? null : Number(l.rating),
    resenas: Number(l.resenas || 0),
    maps: str(l.maps),
    horario: hoursFromRaw(raw, str(l.horario)),
    descripcion: str(raw.description),
    categorias: asArray(raw.categories).map(str).filter(Boolean).slice(0, 6),
    reviews: reviewsFromRaw(raw),
    photos: photos.slice(0, 8),
    socials,
    research
  };
}

// --- Prompt -----------------------------------------------------------------

export function buildWebPrompt(ctx: DemoContext, notas: string): string {
  const reviews = ctx.reviews.length
    ? ctx.reviews
        .map((r) => `- ${r.stars ? `${r.stars}★` : ''} «${r.text}» — ${shortName(r.name)}${r.when ? ` (${r.when})` : ''}`)
        .join('\n')
    : '(no hay reseñas con texto: no inventes ninguna)';
  const photos = ctx.photos.length
    ? ctx.photos.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '(no hay fotos del negocio: diseña SIN fotografías, con tipografía, color, degradados e iconos SVG inline. No uses fotos de stock.)';

  return `Eres un diseñador web senior y copywriter español. Crea la web de demostración de un negocio local real para enseñársela a su dueño en una llamada comercial. Tiene que parecer una web terminada y profesional, hecha para ESTE negocio, no una plantilla.

## Datos reales del negocio (fuente: ficha de Google Maps)
- Nombre: ${ctx.nombre}
- Sector: ${ctx.sector}${ctx.categorias.length ? ` (categorías: ${ctx.categorias.join(', ')})` : ''}
- Dirección: ${ctx.direccion || '[POR CONFIRMAR]'}
- Ciudad: ${ctx.ciudad || '[POR CONFIRMAR]'}
- Teléfono: ${ctx.telefono || '[POR CONFIRMAR]'}
- Email: ${ctx.email || '(no disponible: no lo inventes)'}
- Valoración en Google: ${ctx.rating !== null ? `${ctx.rating} sobre 5 con ${ctx.resenas} reseñas` : 'sin datos'}
- Horario: ${ctx.horario.length ? ctx.horario.join(' · ') : '[POR CONFIRMAR]'}
- Descripción de Google: ${ctx.descripcion || '(no hay)'}
- Google Maps: ${ctx.maps || '(no disponible)'}
- Redes: ${ctx.socials.length ? ctx.socials.join(', ') : 'ninguna conocida'}

## Reseñas reales de clientes (úsalas literalmente, sin cambiar el texto)
${reviews}

## Fotos reales del negocio (usa estas URLs tal cual en <img>; la primera suele ser la mejor para la portada)
${photos}
${ctx.research ? `\n## Información de sus enlaces públicos\n${ctx.research}\n` : ''}${notas ? `\n## Indicaciones del comercial\n${notas}\n` : ''}
## Qué tienes que entregar
Un único archivo HTML completo (<!DOCTYPE html> … </html>), responsive y listo para abrir:
- Usa Tailwind por CDN (<script src="https://cdn.tailwindcss.com"></script>) y Google Fonts (elige una pareja tipográfica que encaje con el sector). Nada más externo salvo las fotos indicadas y el mapa.
- Secciones: cabecera con navegación; portada potente con el nombre, una propuesta de valor concreta y botones «Llamar» (tel:) y «WhatsApp» (https://wa.me/34XXXXXXXXX con su número si es móvil español; si no, solo llamar); servicios (deducidos del sector y de las reseñas, 4–6, con descripciones concretas); por qué elegirnos (apoyado en lo que dicen las reseñas); reseñas reales con estrellas y la nota media de Google; galería con las fotos reales (si hay 2 o más); horario y ubicación con un mapa embebido (<iframe src="https://www.google.com/maps?q=${encodeURIComponent(`${ctx.nombre} ${ctx.direccion || ctx.ciudad}`)}&output=embed">); contacto; pie.
- Paleta y estilo coherentes con el sector y con las fotos. Diseño de agencia: espaciado generoso, jerarquía clara, microinteracciones suaves (hover, transiciones), menú móvil funcional.
- Textos en español de España, cercanos y específicos del negocio y de su barrio/ciudad. Nada de relleno genérico tipo «somos líderes del sector».
- Accesible: textos alternativos, contraste suficiente, botones grandes en móvil.

## Reglas estrictas
- NO inventes datos verificables: precios, años de experiencia, premios, certificaciones, nombres del equipo, número de clientes. Si hace falta un dato que no tienes, escribe [POR CONFIRMAR].
- NO inventes reseñas ni cambies su texto. Atribúyelas solo con el nombre corto indicado.
- NO uses fotos que no estén en la lista.
- Arriba del todo, una franja fina y discreta: «Propuesta de web para ${ctx.nombre} · preparada por ${env.demoBrand}».
- Devuelve SOLO el HTML, sin explicaciones ni bloques de markdown.`;
}

/** Prompt para Lovable: el mismo brief, pidiendo un proyecto editable. */
function buildLovablePrompt(webPrompt: string): string {
  return webPrompt
    .replace(
      /## Qué tienes que entregar[\s\S]*?## Reglas estrictas/,
      `## Qué tienes que entregar
Una web completa con React + Tailwind (una sola página con secciones y menú), responsive y lista para publicar, con: portada con llamada y WhatsApp, servicios, por qué elegirnos, reseñas reales, galería con las fotos reales, horario y mapa, contacto y pie. Diseño de agencia, coherente con el sector.

## Reglas estrictas`
    )
    .replace('- Devuelve SOLO el HTML, sin explicaciones ni bloques de markdown.', '');
}

// --- Llamada a la IA ---------------------------------------------------------

async function callModel(prompt: string): Promise<{ text: string; model: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), env.demoTimeoutMs);
  const system =
    'Eres un diseñador y desarrollador web de primer nivel. Respondes únicamente con un documento HTML completo y válido.';
  try {
    if (env.anthropicApiKey.trim()) {
      const model = env.demoModel || 'claude-sonnet-5-5';
      const res = await fetch(`${env.anthropicApi.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.anthropicApiKey.trim(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 20000, system, messages: [{ role: 'user', content: prompt }] }),
        signal: ctrl.signal
      });
      const j = (await res.json().catch(() => ({}))) as {
        content?: { type: string; text?: string }[];
        error?: { message?: string };
      };
      if (!res.ok) throw new HttpError(502, `IA (Anthropic): ${j.error?.message || `HTTP ${res.status}`}`);
      return { text: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join(''), model };
    }
    if (env.openaiApiKey.trim()) {
      const model = env.demoModel || env.openaiModel;
      const base = env.openaiBaseUrl.replace(/\/+$/, '');
      const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiApiKey.trim()}` },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ]
        }),
        signal: ctrl.signal
      });
      const j = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!res.ok) throw new HttpError(502, `IA: ${j.error?.message || `HTTP ${res.status}`}`);
      return { text: j.choices?.[0]?.message?.content || '', model };
    }
    throw new HttpError(503, 'No hay IA configurada para demos (ANTHROPIC_API_KEY u OPENAI_API_KEY)');
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new HttpError(504, 'La IA ha tardado demasiado. Prueba de nuevo.');
    throw e;
  } finally {
    clearTimeout(to);
  }
}

export function extractHtml(text: string): string {
  let t = text.trim();
  const fence = /```(?:html)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.search(/<!doctype html|<html/i);
  const end = t.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < 0) throw new HttpError(502, 'La IA no devolvió una página HTML válida. Prueba de nuevo.');
  return t.slice(start, end + 7);
}

function withDemoHead(html: string, nombre: string): string {
  const meta = `<meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  const out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : html;
  return /<title>/i.test(out) ? out : out.replace(/<\/head>/i, `<title>${escapeHtml(nombre)}</title></head>`);
}

// --- Demo de CRM (plantilla) -------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const SERVICIOS: [RegExp, string[]][] = [
  [/peluq|barber|estetic|belleza|uñas|unas|manicur/, ['Corte', 'Color', 'Peinado', 'Tratamiento', 'Barba']],
  [/taller|mecan|neumat|coche|moto|chapa/, ['Revisión', 'Cambio de aceite', 'Neumáticos', 'Diagnosis', 'Pre-ITV']],
  [/dental|dentist|odont/, ['Revisión', 'Limpieza', 'Empaste', 'Ortodoncia', 'Blanqueamiento']],
  [/fisio|osteo|rehab|podolog/, ['Valoración', 'Sesión de fisioterapia', 'Masaje', 'Punción seca', 'Rehabilitación']],
  [/restaur|bar|cafeter|brunch|pizz|tapas|comida/, ['Reserva mesa', 'Evento', 'Pedido para llevar', 'Menú grupo', 'Catering']],
  [/gimnas|fitness|yoga|pilates|crossfit|entren/, ['Clase', 'Entrenamiento personal', 'Valoración', 'Alta', 'Bono']],
  [/fontan|electric|cerraj|reform|clima|limpieza/, ['Visita técnica', 'Presupuesto', 'Reparación', 'Urgencia', 'Mantenimiento']],
  [/inmobil/, ['Visita', 'Tasación', 'Captación', 'Firma', 'Seguimiento']]
];

function crmServices(sector: string): string[] {
  const k = sector.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (SERVICIOS.find(([re]) => re.test(k)) || [null, ['Cita', 'Presupuesto', 'Servicio', 'Seguimiento', 'Revisión']])[1] as string[];
}

export function renderCrmDemo(ctx: DemoContext): string {
  const e = escapeHtml;
  const servicios = crmServices(ctx.sector);
  const clientes = ['Laura M.', 'Javier R.', 'Carmen S.', 'Pablo G.', 'Marta L.', 'Andrés P.', 'Lucía F.', 'Sergio N.'];
  const horas = ['09:00', '10:30', '12:00', '13:30', '16:00', '17:30', '19:00'];
  const dias = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const cell = (d: number, h: number) => {
    const n = (d * 7 + h * 3 + ctx.nombre.length) % 5;
    if (n > 2) return '<td></td>';
    const c = clientes[(d + h * 2) % clientes.length];
    const s = servicios[(d + h) % servicios.length];
    return `<td><div class="ev ev${n}"><b>${e(c)}</b><span>${e(s)}</span></div></td>`;
  };
  const photo = ctx.photos[0];
  const rating = ctx.rating !== null ? ctx.rating.toFixed(1) : '—';
  const wa = ctx.telefono.replace(/\D/g, '');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${e(ctx.nombre)} · Gestión de clientes</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#F5F7FB;--card:#fff;--ink:#0F172A;--muted:#64748B;--line:#E2E8F0;--acc:#2563EB;--acc2:#0EA5E9;--ok:#059669;--warn:#D97706}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px}
.banner{background:#0F172A;color:#CBD5E1;font-size:12px;text-align:center;padding:6px 12px}
.app{display:grid;grid-template-columns:232px 1fr;min-height:calc(100vh - 28px)}
aside{background:#0B1220;color:#E2E8F0;padding:20px 14px;display:flex;flex-direction:column;gap:4px}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:18px}.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:grid;place-items:center;font-weight:700;color:#fff;overflow:hidden}.logo img{width:100%;height:100%;object-fit:cover}
.brand b{display:block;font-size:14px;line-height:1.2}.brand small{color:#94A3B8;font-size:11px}
nav a{display:block;padding:9px 12px;border-radius:8px;color:#CBD5E1;text-decoration:none;font-weight:500}nav a.on,nav a:hover{background:#1E293B;color:#fff}
main{padding:24px 28px;overflow:auto}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}.kpi small{color:var(--muted)}.kpi b{display:block;font-size:24px;margin-top:6px}.kpi em{font-style:normal;color:var(--ok);font-size:12px}
.grid{display:grid;grid-template-columns:1.7fr 1fr;gap:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.card h2{font-size:15px;margin:0 0 14px;display:flex;justify-content:space-between;align-items:center}
.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:600;font-size:13px;cursor:pointer}
table.cal{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed}.cal th{font-size:12px;color:var(--muted);font-weight:600;text-align:left;padding:4px}.cal td{height:46px;vertical-align:top}.cal td.h{font-size:11px;color:var(--muted);width:46px}
.ev{border-radius:8px;padding:5px 7px;font-size:11px;line-height:1.25;height:100%}.ev b{display:block;font-weight:600}.ev span{opacity:.8}.ev0{background:#DBEAFE;color:#1E3A8A}.ev1{background:#DCFCE7;color:#14532D}.ev2{background:#FEF3C7;color:#78350F}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.list li:last-child{border:0}
.av{width:32px;height:32px;border-radius:50%;background:#E0E7FF;color:#3730A3;display:grid;place-items:center;font-weight:700;font-size:12px}.grow{flex:1}.tag{font-size:11px;padding:3px 8px;border-radius:999px;background:#F1F5F9;color:#334155}.tag.ok{background:#DCFCE7;color:#166534}.tag.w{background:#FEF3C7;color:#92400E}
.wa{display:flex;gap:10px;align-items:flex-start;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:12px;margin-top:12px;font-size:13px}
.note{font-size:11px;color:var(--muted);margin-top:18px}
@media(max-width:900px){.app{grid-template-columns:1fr}aside{flex-direction:row;overflow:auto;padding:10px}.brand{margin:0 12px 0 0}nav{display:flex;gap:4px}.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}main{padding:16px}}
</style></head><body>
<div class="banner">Demostración preparada para ${e(ctx.nombre)} por ${e(env.demoBrand)} · los clientes y citas son de ejemplo</div>
<div class="app"><aside><div class="brand"><div class="logo">${photo ? `<img src="${e(photo)}" alt="">` : e(ctx.nombre.slice(0, 1).toUpperCase())}</div><div><b>${e(ctx.nombre)}</b><small>${e(ctx.ciudad || ctx.sector)}</small></div></div>
<nav><a class="on" href="#">Agenda</a><a href="#">Clientes</a><a href="#">Servicios</a><a href="#">Recordatorios</a><a href="#">Reseñas</a><a href="#">Informes</a></nav></aside>
<main><h1>Buenos días 👋</h1><p class="sub">Así se vería la gestión diaria de ${e(ctx.nombre)}: citas, clientes y recordatorios por WhatsApp en un solo sitio.</p>
<div class="kpis"><div class="kpi"><small>Citas esta semana</small><b>38</b><em>▲ 12% vs. semana pasada</em></div><div class="kpi"><small>Clientes activos</small><b>214</b><em>▲ 9 nuevos este mes</em></div><div class="kpi"><small>Ausencias evitadas</small><b>17</b><em>gracias a recordatorios</em></div><div class="kpi"><small>Nota en Google</small><b>${e(rating)} ★</b><em>${ctx.resenas} reseñas</em></div></div>
<div class="grid"><div class="card"><h2>Agenda de la semana <button class="btn">+ Nueva cita</button></h2><table class="cal"><tr><th></th>${dias.map((d) => `<th>${d}</th>`).join('')}</tr>
${horas.map((h, hi) => `<tr><td class="h">${h}</td>${dias.map((_, di) => cell(di, hi)).join('')}</tr>`).join('')}</table></div>
<div class="card"><h2>Próximos clientes</h2><ul class="list">${clientes.slice(0, 5).map((c, i) => `<li><span class="av">${e(c.split(' ').map((x) => x[0]).join(''))}</span><span class="grow"><b>${e(c)}</b><br><small style="color:var(--muted)">${e(servicios[i % servicios.length])} · ${horas[i]}</small></span><span class="tag ${i % 3 === 0 ? 'ok' : i % 3 === 1 ? 'w' : ''}">${i % 3 === 0 ? 'Confirmada' : i % 3 === 1 ? 'Pendiente' : 'Recordada'}</span></li>`).join('')}</ul>
<div class="wa"><span>💬</span><span><b>Recordatorio automático por WhatsApp</b><br>«Hola Laura, te recordamos tu cita de ${e(servicios[0].toLowerCase())} mañana a las 10:30 en ${e(ctx.nombre)}. Responde 1 para confirmar o 2 para cambiarla.»${wa ? `<br><small style="color:var(--muted)">Enviado desde el número del negocio</small>` : ''}</span></div></div></div>
<div class="card" style="margin-top:18px"><h2>Servicios</h2><div style="display:flex;flex-wrap:wrap;gap:8px">${servicios.map((s) => `<span class="tag">${e(s)}</span>`).join('')}</div></div>
<p class="note">Demo interactiva de ejemplo. En la versión real se conecta con tu agenda, tu WhatsApp y tu ficha de Google.</p></main></div></body></html>`;
}

// --- Rutas -------------------------------------------------------------------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'demo'
  );
}

function lovableUrl(prompt: string, photos: string[]): string {
  const imgs = photos.filter((p) => /\.(jpe?g|png|webp)(\?|$)/i.test(p)).slice(0, 10);
  return `https://lovable.dev/#prompt=${encodeURIComponent(prompt.slice(0, 49000))}${imgs.map((i) => `&images=${encodeURIComponent(i)}`).join('')}`;
}

/** GET /api/demos/status — si hay IA para demos. */
demosApi.get('/demos/status', (_req, res) => {
  res.json({ configured: hasDemoAI(), provider: env.anthropicApiKey.trim() ? 'anthropic' : env.openaiApiKey.trim() ? 'openai' : null });
});

/** POST /api/demos/prompt { lead_id, notas?, analizar? } — vista previa del prompt y fuentes, sin generar. */
demosApi.post(
  '/demos/prompt',
  ah(async (req, res) => {
    const leadId = optStr(req.body?.lead_id, 80);
    if (!leadId) throw new HttpError(400, 'Falta lead_id');
    const ctx = await buildContext(req, leadId, req.body?.analizar !== false);
    const prompt = buildWebPrompt(ctx, optStr(req.body?.notas, 2000) || '');
    res.json({
      prompt,
      lovable_url: lovableUrl(buildLovablePrompt(prompt), ctx.photos),
      fuentes: { reseñas: ctx.reviews.length, fotos: ctx.photos.length, redes: ctx.socials.length, enlaces_analizados: !!ctx.research }
    });
  })
);

/**
 * POST /api/demos { lead_id, tipo: 'web'|'crm', notas?, analizar? }
 * Genera y publica la demo. Devuelve { demo: { id, slug, url, tipo }, lovable_url }.
 */
demosApi.post(
  '/demos',
  ah(async (req, res) => {
    const leadId = optStr(req.body?.lead_id, 80);
    if (!leadId) throw new HttpError(400, 'Falta lead_id');
    const tipo = req.body?.tipo === 'crm' ? 'crm' : 'web';
    const user = req.user!;
    if (tipo === 'web' && !genLimit(`u:${user.id}`, 40)) {
      throw new HttpError(429, 'Has generado muchas demos en la última hora. Espera un poco.');
    }
    const ctx = await buildContext(req, leadId, req.body?.analizar !== false);
    const notas = optStr(req.body?.notas, 2000) || '';

    let html: string;
    let prompt: string | null = null;
    let modelo: string | null = null;
    if (tipo === 'crm') {
      html = renderCrmDemo(ctx);
    } else {
      prompt = buildWebPrompt(ctx, notas);
      const out = await callModel(prompt);
      html = withDemoHead(extractHtml(out.text), ctx.nombre);
      modelo = out.model;
    }

    const id = crypto.randomUUID();
    const slug = `${slugify(ctx.nombre)}-${tipo}-${crypto.randomBytes(3).toString('hex')}`;
    await query(
      `INSERT INTO demos (id, slug, lead_id, tipo, html, prompt, modelo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, slug, leadId, tipo, html, prompt, modelo, user.id]
    );
    await query(
      `INSERT INTO lead_interactions (id, lead_id, user_id, tipo, nota) VALUES ($1,$2,$3,'nota',$4)`,
      [crypto.randomUUID(), leadId, user.id, `Demo ${tipo === 'web' ? 'web' : 'de CRM'} generada: /demo/${slug}`]
    );
    await query('UPDATE leads SET updated_at = now() WHERE id = $1', [leadId]);

    const base = publicBase(req);
    res.status(201).json({
      demo: { id, slug, tipo, url: `${base}/demo/${slug}`, modelo, created_at: new Date().toISOString(), visitas: 0 },
      lovable_url: prompt ? lovableUrl(buildLovablePrompt(prompt), ctx.photos) : null,
      fuentes: { reseñas: ctx.reviews.length, fotos: ctx.photos.length, redes: ctx.socials.length, enlaces_analizados: !!ctx.research }
    });
  })
);

/** GET /api/demos?lead_id= — demos de un lead (con visitas). */
demosApi.get(
  '/demos',
  ah(async (req, res) => {
    const leadId = optStr(req.query.lead_id, 80);
    if (!leadId) throw new HttpError(400, 'Falta lead_id');
    const args: unknown[] = [leadId];
    const vis = visibility(req.user, args);
    const ok = await query(`SELECT 1 FROM leads WHERE id = $1 AND ${vis}`, args);
    if (!ok.length) throw new HttpError(404, 'Lead no encontrado');
    const base = publicBase(req);
    const rows = await query<{ slug: string }>(
      `SELECT id, slug, tipo, modelo, visitas, ultima_visita, created_at, created_by FROM demos WHERE lead_id = $1 ORDER BY created_at DESC`,
      [leadId]
    );
    res.json({ demos: rows.map((d) => ({ ...d, url: `${base}/demo/${d.slug}` })) });
  })
);

/** GET /demo/:slug — pública, aislada con CSP sandbox. */
demosPublic.get(
  '/demo/:slug',
  ah(async (req, res) => {
    const rows = await query<{ html: string; id: string }>('SELECT id, html FROM demos WHERE slug = $1', [req.params.slug]);
    if (!rows.length) {
      res.status(404).type('text/plain').send('Demo no encontrada');
      return;
    }
    // Las visitas cuentan solo si no es un bot de vista previa (WhatsApp, etc.).
    const ua = String(req.headers['user-agent'] || '');
    if (!/bot|preview|whatsapp|facebookexternalhit|slack|telegram/i.test(ua)) {
      void query('UPDATE demos SET visitas = visitas + 1, ultima_visita = now() WHERE id = $1', [rows[0].id]).catch(() => undefined);
    }
    res.setHeader(
      'Content-Security-Policy',
      'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-top-navigation-by-user-activation'
    );
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(rows[0].html);
  })
);
