/**
 * Web de demostración económica (v1.4.3).
 *
 * La IA NO escribe el HTML: solo redacta los textos en un JSON pequeño
 * (≈700 tokens de salida). El servidor los pinta en una plantilla
 * profesional y responsive, con los datos, fotos y reseñas reales.
 * Coste aproximado con Claude Haiku 5.5: 0,0005 $ por demo.
 * Si no hay IA o se acaba el presupuesto, los textos salen de una
 * plantilla por sector (coste 0).
 */

export interface WebReview {
  stars: number | null;
  text: string;
  name: string;
}

export interface WebCtx {
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
  reviews: WebReview[];
  photos: string[];
  socials: string[];
  research: string;
}

export interface WebCopy {
  titulo: string;
  subtitulo: string;
  sobre: string;
  servicios: { nombre: string; descripcion: string }[];
  motivos: { titulo: string; texto: string }[];
  cta: string;
}

// --- Estilo por sector ------------------------------------------------------

interface Theme {
  key: string;
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  soft: string;
  dark: string;
  display: string;
  body: string;
  fonts: string;
}

const T = (o: Omit<Theme, 'fonts'>, fonts: string): Theme => ({ ...o, fonts });

const THEMES: [RegExp, Theme][] = [
  [/peluq|barber|estetic|belleza|unas|manicur|spa|maquill/, T({ key: 'belleza', bg: '#FBF8F6', ink: '#1F1A1C', muted: '#6E6266', accent: '#9C4A64', accentInk: '#fff', soft: '#F3E7EA', dark: '#2A1E22', display: "'Cormorant Garamond', Georgia, serif", body: "'Manrope', system-ui, sans-serif" }, 'Cormorant+Garamond:wght@500;600;700&family=Manrope:wght@400;500;600;700')],
  [/taller|mecan|neumat|coche|moto|chapa|automo/, T({ key: 'motor', bg: '#F5F6F7', ink: '#14171A', muted: '#5C6570', accent: '#E8590C', accentInk: '#fff', soft: '#FFE8D9', dark: '#15191E', display: "'Barlow Condensed', 'Arial Narrow', sans-serif", body: "'Barlow', system-ui, sans-serif" }, 'Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600')],
  [/dental|dentist|odont|fisio|osteo|rehab|podolog|clinic|medic|psicolog|veterin|optica/, T({ key: 'salud', bg: '#F6FAFA', ink: '#0F2427', muted: '#56696C', accent: '#0F8B8D', accentInk: '#fff', soft: '#DDF1F1', dark: '#0C2629', display: "'Fraunces', Georgia, serif", body: "'Inter', system-ui, sans-serif" }, 'Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600')],
  [/restaur|bar|cafeter|brunch|pizz|tapas|comida|panader|pasteler|heladeri|asador/, T({ key: 'restauracion', bg: '#FBF7F1', ink: '#231A12', muted: '#6F6152', accent: '#B4532A', accentInk: '#fff', soft: '#F3E3D3', dark: '#2A1D14', display: "'Playfair Display', Georgia, serif", body: "'Work Sans', system-ui, sans-serif" }, 'Playfair+Display:wght@600;700&family=Work+Sans:wght@400;500;600')],
  [/gimnas|fitness|yoga|pilates|crossfit|entren|box|danza/, T({ key: 'deporte', bg: '#F4F5F2', ink: '#111311', muted: '#5D635B', accent: '#3F7D20', accentInk: '#fff', soft: '#E1EED6', dark: '#121611', display: "'Archivo', system-ui, sans-serif", body: "'Archivo', system-ui, sans-serif" }, 'Archivo:wght@400;500;600;800')],
  [/fontan|electric|cerraj|reform|clima|limpieza|pintor|carpint|jardin|mudanz|construc/, T({ key: 'oficios', bg: '#F5F7FA', ink: '#0E1A2B', muted: '#566275', accent: '#1F5FBF', accentInk: '#fff', soft: '#DFE9F8', dark: '#0D1A2E', display: "'Sora', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" }, 'Sora:wght@600;700&family=Inter:wght@400;500;600')],
  [/inmobil|asesor|abogad|gestor|consult|seguros/, T({ key: 'profesional', bg: '#F7F6F3', ink: '#151A22', muted: '#5F6672', accent: '#8A6A2F', accentInk: '#fff', soft: '#EFE7D6', dark: '#141A24', display: "'Libre Baskerville', Georgia, serif", body: "'Inter', system-ui, sans-serif" }, 'Libre+Baskerville:wght@400;700&family=Inter:wght@400;500;600')]
];

const DEFAULT_THEME = T({ key: 'general', bg: '#F6F7FB', ink: '#141A2A', muted: '#5B6375', accent: '#3554D1', accentInk: '#fff', soft: '#E3E9FB', dark: '#121830', display: "'DM Serif Display', Georgia, serif", body: "'DM Sans', system-ui, sans-serif" }, 'DM+Serif+Display&family=DM+Sans:wght@400;500;600;700');

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function themeFor(sector: string): Theme {
  const k = norm(sector);
  return (THEMES.find(([re]) => re.test(k)) || [null, DEFAULT_THEME])[1] as Theme;
}

// --- Textos sin IA (plantilla por sector) ------------------------------------

const SECTOR_SERVICES: [RegExp, [string, string][]][] = [
  [/peluq|barber/, [['Corte y peinado', 'Cortes actuales y clásicos adaptados a tu estilo.'], ['Color y mechas', 'Coloración y mechas con productos profesionales.'], ['Tratamientos', 'Cuidado e hidratación para un cabello sano.'], ['Barba', 'Arreglo y perfilado de barba.']]],
  [/estetic|belleza|unas|manicur|spa/, [['Manicura y pedicura', 'Uñas cuidadas y duraderas.'], ['Tratamientos faciales', 'Limpieza e hidratación de la piel.'], ['Depilación', 'Servicio rápido y cuidadoso.'], ['Masajes', 'Relajación y bienestar.']]],
  [/taller|mecan|neumat|coche|moto|chapa/, [['Revisión y mantenimiento', 'Aceite, filtros y puntos de seguridad.'], ['Neumáticos', 'Cambio, equilibrado y alineación.'], ['Diagnosis', 'Detección de averías con equipo de diagnosis.'], ['Pre-ITV', 'Revisamos tu vehículo antes de pasar la ITV.']]],
  [/dental|dentist|odont/, [['Revisión y limpieza', 'Cuidado preventivo de tu salud bucal.'], ['Empastes', 'Tratamiento de caries.'], ['Ortodoncia', 'Soluciones para alinear tu sonrisa.'], ['Estética dental', 'Blanqueamiento y mejora de la sonrisa.']]],
  [/fisio|osteo|rehab/, [['Fisioterapia', 'Tratamiento de dolores y lesiones.'], ['Rehabilitación', 'Recuperación tras lesiones u operaciones.'], ['Masaje terapéutico', 'Alivio de tensiones y contracturas.'], ['Valoración', 'Estudiamos tu caso antes de empezar.']]],
  [/restaur|bar|cafeter|brunch|pizz|tapas|comida|asador/, [['Carta', 'Platos preparados al momento.'], ['Menú del día', 'Cocina casera de lunes a viernes.'], ['Reservas', 'Reserva tu mesa por teléfono o WhatsApp.'], ['Para llevar', 'Recoge tu pedido en el local.']]],
  [/gimnas|fitness|yoga|pilates|crossfit|entren/, [['Clases dirigidas', 'Sesiones en grupo para todos los niveles.'], ['Entrenamiento personal', 'Plan adaptado a tus objetivos.'], ['Sala', 'Equipamiento para entrenar a tu ritmo.'], ['Primera visita', 'Ven a conocernos y te asesoramos.']]],
  [/fontan|electric|cerraj|reform|clima|limpieza|pintor|carpint/, [['Presupuesto sin compromiso', 'Valoramos el trabajo antes de empezar.'], ['Reparaciones', 'Solución rápida a averías.'], ['Instalaciones', 'Trabajos nuevos con garantía.'], ['Urgencias', 'Te atendemos cuando lo necesitas.']]],
  [/inmobil/, [['Compra', 'Te ayudamos a encontrar tu vivienda.'], ['Venta', 'Valoración y comercialización de tu inmueble.'], ['Alquiler', 'Gestión de alquileres.'], ['Asesoramiento', 'Te acompañamos en todo el proceso.']]]
];

export function fallbackCopy(ctx: WebCtx): WebCopy {
  const k = norm(ctx.sector);
  const svc = (SECTOR_SERVICES.find(([re]) => re.test(k)) || [null, [['Atención personalizada', 'Te escuchamos y te asesoramos.'], ['Servicio profesional', 'Trabajo cuidado y de calidad.'], ['Cita previa', 'Reserva por teléfono o WhatsApp.']]])[1] as [string, string][];
  const lugar = ctx.ciudad ? ` en ${ctx.ciudad}` : '';
  const nota = ctx.rating !== null && ctx.resenas ? `${ctx.rating.toFixed(1).replace('.', ',')} sobre 5 en Google con ${ctx.resenas} opiniones` : '';
  return {
    titulo: `${ctx.sector}${lugar}`,
    subtitulo: nota ? `${ctx.nombre}: ${nota}. Contacta y te atendemos.` : `${ctx.nombre}. Contacta y te atendemos.`,
    sobre: ctx.descripcion || `En ${ctx.nombre} trabajamos para ofrecer un servicio cercano y de confianza${lugar}.`,
    servicios: svc.map(([nombre, descripcion]) => ({ nombre, descripcion })),
    motivos: [
      { titulo: 'Trato cercano', texto: 'Atención directa y personalizada.' },
      { titulo: nota ? 'Bien valorados' : 'Profesionales', texto: nota ? `Así nos valoran nuestros clientes en Google.` : 'Experiencia y cuidado en cada trabajo.' },
      { titulo: 'Fácil de contactar', texto: 'Llámanos o escríbenos por WhatsApp.' }
    ],
    cta: 'Pide cita o información'
  };
}

// --- Prompt compacto ----------------------------------------------------------

export const COPY_SYSTEM =
  'Eres copywriter de webs para negocios locales en España. Respondes SOLO con un objeto JSON válido, sin texto adicional ni markdown.';

function shortName(n: string): string {
  const parts = n.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Cliente';
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
}

export function buildCopyPrompt(ctx: WebCtx, notas: string): string {
  const rev = ctx.reviews
    .slice(0, 4)
    .map((r) => `- «${r.text.slice(0, 280)}» (${shortName(r.name)})`)
    .join('\n');
  return `Negocio: ${ctx.nombre}
Sector: ${ctx.sector}${ctx.categorias.length ? ` (${ctx.categorias.slice(0, 4).join(', ')})` : ''}
Ciudad: ${ctx.ciudad || 'no indicada'}
Google: ${ctx.rating !== null ? `${ctx.rating}/5, ${ctx.resenas} reseñas` : 'sin datos'}
Descripción: ${(ctx.descripcion || 'no hay').slice(0, 300)}
${rev ? `Reseñas reales:\n${rev}` : 'Sin reseñas con texto.'}
${ctx.research ? `Info pública:\n${ctx.research.slice(0, 600)}\n` : ''}${notas ? `Indicaciones del comercial: ${notas.slice(0, 300)}\n` : ''}
Escribe los textos de su web en español de España, concretos para este negocio (apóyate en lo que dicen las reseñas), sin relleno genérico.
NO inventes precios, años, premios, certificaciones, nombres de personas ni cifras.
Devuelve exactamente este JSON:
{"titulo":"máx. 8 palabras","subtitulo":"máx. 25 palabras","sobre":"máx. 60 palabras","servicios":[{"nombre":"máx. 4 palabras","descripcion":"máx. 16 palabras"}],"motivos":[{"titulo":"máx. 4 palabras","texto":"máx. 14 palabras"}],"cta":"máx. 8 palabras"}
Con 4 a 6 servicios y exactamente 3 motivos.`;
}

function clip(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Valida y recorta lo que devuelve la IA; si algo falta, completa con la plantilla. */
export function parseCopy(text: string, ctx: WebCtx): WebCopy | null {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1];
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
  const fb = fallbackCopy(ctx);
  const servicios = (Array.isArray(o.servicios) ? o.servicios : [])
    .map((x) => ({ nombre: clip((x as Record<string, unknown>)?.nombre, 60), descripcion: clip((x as Record<string, unknown>)?.descripcion, 160) }))
    .filter((x) => x.nombre)
    .slice(0, 6);
  const motivos = (Array.isArray(o.motivos) ? o.motivos : [])
    .map((x) => ({ titulo: clip((x as Record<string, unknown>)?.titulo, 50), texto: clip((x as Record<string, unknown>)?.texto, 140) }))
    .filter((x) => x.titulo)
    .slice(0, 3);
  return {
    titulo: clip(o.titulo, 90) || fb.titulo,
    subtitulo: clip(o.subtitulo, 220) || fb.subtitulo,
    sobre: clip(o.sobre, 520) || fb.sobre,
    servicios: servicios.length >= 3 ? servicios : fb.servicios,
    motivos: motivos.length === 3 ? motivos : fb.motivos,
    cta: clip(o.cta, 70) || fb.cta
  };
}

// --- Plantilla HTML -----------------------------------------------------------

function e(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function waNumber(tel: string): string {
  const d = tel.replace(/\D/g, '');
  if (/^[67]\d{8}$/.test(d)) return `34${d}`;
  if (/^34[67]\d{8}$/.test(d)) return d;
  return '';
}

function stars(n: number | null): string {
  const r = Math.round(n ?? 5);
  return '★★★★★'.slice(0, r) + '☆☆☆☆☆'.slice(0, 5 - r);
}

export function renderWebDemo(ctx: WebCtx, copy: WebCopy, brand: string): string {
  const t = themeFor(ctx.sector);
  const tel = ctx.telefono.replace(/[^\d+]/g, '');
  const wa = waNumber(ctx.telefono);
  const hero = ctx.photos[0];
  const gallery = ctx.photos.slice(1, 7);
  const reviews = ctx.reviews.slice(0, 6);
  const nota = ctx.rating !== null ? ctx.rating.toFixed(1).replace('.', ',') : '';
  const mapQ = encodeURIComponent(`${ctx.nombre} ${ctx.direccion || ctx.ciudad}`);
  const initial = e(ctx.nombre.trim().slice(0, 1).toUpperCase() || 'N');
  const ctaPrimary = wa
    ? `<a class="btn" href="https://wa.me/${wa}?text=${encodeURIComponent(`Hola, quería información de ${ctx.nombre}`)}" target="_blank" rel="noopener">WhatsApp</a>`
    : '';
  const ctaCall = tel ? `<a class="btn ${wa ? 'ghost' : ''}" href="tel:${e(tel)}">Llamar · ${e(ctx.telefono)}</a>` : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${e(ctx.nombre)}${ctx.ciudad ? ` · ${e(ctx.sector)} en ${e(ctx.ciudad)}` : ''}</title>
<meta name="description" content="${e(copy.subtitulo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${t.fonts}&display=swap" rel="stylesheet">
<style>
:root{--bg:${t.bg};--ink:${t.ink};--muted:${t.muted};--acc:${t.accent};--acc-ink:${t.accentInk};--soft:${t.soft};--dark:${t.dark};--fd:${t.display};--fb:${t.body}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.65 var(--fb);-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:0 22px}
.strip{background:var(--dark);color:rgba(255,255,255,.75);font-size:12.5px;text-align:center;padding:7px 12px}
header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}
header .wrap{display:flex;align-items:center;gap:20px;height:70px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;font:600 20px/1.1 var(--fd)}
.logo i{width:38px;height:38px;border-radius:50%;background:var(--acc);color:var(--acc-ink);display:grid;place-items:center;font:600 17px var(--fb);font-style:normal}
nav{margin-left:auto;display:flex;gap:26px;font-size:15px}nav a{text-decoration:none;color:var(--muted)}nav a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:50px;padding:0 24px;border-radius:999px;background:var(--acc);color:var(--acc-ink);text-decoration:none;font-weight:600;font-size:15.5px;border:1px solid var(--acc);transition:transform .2s,box-shadow .2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px -12px var(--acc)}
.btn.ghost{background:transparent;color:inherit;border-color:currentColor}
header .btn{min-height:42px;padding:0 18px;font-size:14.5px}
.hero{position:relative;color:${hero ? '#fff' : 'var(--ink)'};${hero ? '' : 'background:linear-gradient(160deg,var(--soft),var(--bg));'}}
.hero .bgimg{position:absolute;inset:0;background:url("${hero ? e(hero) : ''}") center/cover;${hero ? '' : 'display:none;'}}
.hero .shade{position:absolute;inset:0;background:linear-gradient(100deg,rgba(0,0,0,.72) 0%,rgba(0,0,0,.45) 55%,rgba(0,0,0,.15) 100%);${hero ? '' : 'display:none;'}}
.hero .wrap{position:relative;padding-block:120px 110px;max-width:1160px}
.eyebrow{font-size:13px;letter-spacing:.14em;text-transform:uppercase;opacity:.85;margin-bottom:18px}
h1,h2,h3{font-family:var(--fd);line-height:1.08;margin:0;font-weight:600;text-wrap:balance}
.hero h1{font-size:clamp(40px,6vw,72px);max-width:15ch}
.hero p{font-size:clamp(17px,2vw,20px);max-width:52ch;margin:22px 0 32px;opacity:.92}
.hero .ctas{display:flex;gap:12px;flex-wrap:wrap}
.hero .ghost{color:${hero ? '#fff' : 'var(--ink)'}}
.hero .split{display:grid;grid-template-columns:1.25fr .75fr;gap:48px;align-items:center}
.hcard{background:#fff;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);border-radius:22px;padding:28px;box-shadow:0 30px 60px -36px rgba(0,0,0,.35);display:grid;gap:18px}
.hcard .sc{display:flex;align-items:baseline;gap:10px}.hcard .sc b{font:600 52px/1 var(--fd)}.hcard .sc span{color:#E0A100;letter-spacing:2px}
.hcard small{color:var(--muted);font-size:14px}
.hcard ul{list-style:none;margin:0;padding:0;display:grid;gap:10px;border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent);padding-top:16px;font-size:15px}
.hcard li{display:flex;gap:10px}.hcard li i{font-style:normal;color:var(--acc)}
.facts{background:var(--dark);color:#fff}
.facts .wrap{display:grid;grid-template-columns:repeat(3,1fr);gap:0}
.facts div{padding:26px 22px}.facts div+div{border-left:1px solid rgba(255,255,255,.12)}
.facts b{display:block;font:600 26px/1.1 var(--fd)}.facts span{font-size:14px;opacity:.7}
section{padding-block:96px}
.head{max-width:660px;margin-bottom:46px}.head .eyebrow{color:var(--acc);opacity:1}
h2{font-size:clamp(32px,4vw,48px)}
.svc{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.card{background:#fff;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);border-radius:18px;padding:28px;transition:transform .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px);box-shadow:0 18px 40px -26px rgba(0,0,0,.35)}
.card .n{width:42px;height:42px;border-radius:12px;background:var(--soft);color:var(--acc);display:grid;place-items:center;font-weight:700;margin-bottom:18px}
.card h3{font-size:22px;margin-bottom:8px}.card p{margin:0;color:var(--muted);font-size:15.5px}
.about{background:#fff}
.about .wrap{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center}
.about p.big{font-size:19px;color:var(--muted)}
.why{display:grid;gap:14px;margin-top:28px}
.why>div{display:grid;grid-template-columns:34px 1fr;gap:14px;align-items:start}
.why i{width:34px;height:34px;border-radius:50%;background:var(--acc);color:var(--acc-ink);display:grid;place-items:center;font-style:normal;font-size:15px}
.why b{display:block}.why span{color:var(--muted);font-size:15.5px}
.about .ph{aspect-ratio:4/5;border-radius:24px;overflow:hidden;background:var(--soft) center/cover}
.about .panel{border-radius:24px;background:var(--dark);color:#fff;padding:40px;display:flex;flex-direction:column;gap:22px}
.about .panel .big-i{width:72px;height:72px;border-radius:20px;background:var(--acc);color:var(--acc-ink);display:grid;place-items:center;font:600 34px var(--fd)}
.about .panel dl{margin:0;display:grid;gap:16px}.about .panel dt{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.6}.about .panel dd{margin:2px 0 0;font-size:18px}
.gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.gal div{aspect-ratio:1;border-radius:16px;background:var(--soft) center/cover}
.rv{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.rv figure{margin:0;background:#fff;border-radius:18px;padding:26px;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);display:flex;flex-direction:column;gap:14px}
.rv .st{color:#E0A100;letter-spacing:2px}.rv blockquote{margin:0;font-size:16.5px}.rv figcaption{margin-top:auto;color:var(--muted);font-size:14px}
.score{display:inline-flex;align-items:center;gap:12px;background:#fff;border-radius:999px;padding:10px 18px;margin-top:16px;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}
.score b{font:600 24px var(--fd)}
.visit .wrap{display:grid;grid-template-columns:.9fr 1.1fr;gap:40px}
.hours{list-style:none;margin:20px 0 0;padding:0}.hours li{padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent);font-size:15.5px}
.map{border-radius:20px;overflow:hidden;min-height:340px;background:var(--soft)}.map iframe{width:100%;height:100%;min-height:340px;border:0}
.final{background:var(--acc);color:var(--acc-ink);text-align:center}
.final h2{max-width:20ch;margin:0 auto 26px}.final .btn{background:#fff;color:var(--acc);border-color:#fff}.final .ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.6)}
.final .ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
footer{background:var(--dark);color:rgba(255,255,255,.7);font-size:14px}footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-block:28px}
.wa-float{position:fixed;right:18px;bottom:18px;z-index:30;width:58px;height:58px;border-radius:50%;background:#25D366;display:grid;place-items:center;box-shadow:0 12px 30px -10px rgba(0,0,0,.45)}
.wa-float svg{width:30px;height:30px;fill:#fff}
@media(max-width:860px){.hero .split{grid-template-columns:1fr;gap:32px}nav{display:none}.facts .wrap{grid-template-columns:1fr}.facts div+div{border-left:0;border-top:1px solid rgba(255,255,255,.12)}.about .wrap,.visit .wrap{grid-template-columns:1fr}.gal{grid-template-columns:repeat(2,1fr)}section{padding-block:72px}.hero .wrap{padding-block:84px 80px}header .btn{display:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style></head><body>
<div class="strip">Propuesta de web para ${e(ctx.nombre)} · preparada por ${e(brand)}</div>
<header><div class="wrap"><a class="logo" href="#"><i>${initial}</i>${e(ctx.nombre)}</a>
<nav><a href="#servicios">Servicios</a><a href="#nosotros">Nosotros</a>${reviews.length ? '<a href="#opiniones">Opiniones</a>' : ''}<a href="#contacto">Contacto</a></nav>
${tel ? `<a class="btn" href="tel:${e(tel)}">Llamar</a>` : ''}</div></header>
<section class="hero" style="padding:0"><div class="bgimg" role="img" aria-label="${e(ctx.nombre)}"></div><div class="shade"></div><div class="wrap">
${hero ? '' : '<div class="split"><div>'}<div class="eyebrow">${e(ctx.sector)}${ctx.ciudad ? ` · ${e(ctx.ciudad)}` : ''}</div>
<h1>${e(copy.titulo)}</h1><p>${e(copy.subtitulo)}</p>
<div class="ctas">${ctaPrimary}${ctaCall}${!ctaPrimary && !ctaCall ? '<a class="btn" href="#contacto">Contactar</a>' : ''}</div>${
    hero
      ? ''
      : `</div><aside class="hcard">${nota ? `<div><div class="sc"><b>${nota}</b><span>${stars(ctx.rating)}</span></div><small>${ctx.resenas} opiniones en Google</small></div>` : `<div><div class="sc"><b style="font-size:34px">${e(ctx.nombre)}</b></div><small>${e(ctx.sector)}</small></div>`}<ul>${ctx.direccion || ctx.ciudad ? `<li><i>●</i>${e(ctx.direccion || ctx.ciudad)}</li>` : ''}${ctx.horario[0] ? `<li><i>●</i>${e(ctx.horario[0])}</li>` : ''}${tel ? `<li><i>●</i>${e(ctx.telefono)}</li>` : ''}</ul></aside></div>`
  }</div></section>
<div class="facts"><div class="wrap">
<div><b>${nota ? `${nota} ★` : e(ctx.sector)}</b><span>${nota ? `${ctx.resenas} opiniones en Google` : 'Negocio local'}</span></div>
<div><b>${e(ctx.ciudad || 'Cerca de ti')}</b><span>${e(ctx.direccion || 'Atención en nuestro local')}</span></div>
<div><b>${tel ? e(ctx.telefono) : 'Pide cita'}</b><span>${wa ? 'Llamada o WhatsApp' : 'Te atendemos'}</span></div>
</div></div>
<section id="servicios"><div class="wrap"><div class="head"><div class="eyebrow">Servicios</div><h2>Lo que hacemos por ti</h2></div>
<div class="svc">${copy.servicios.map((s, i) => `<div class="card"><div class="n">${String(i + 1).padStart(2, '0')}</div><h3>${e(s.nombre)}</h3><p>${e(s.descripcion)}</p></div>`).join('')}</div></div></section>
<section class="about" id="nosotros"><div class="wrap"><div><div class="head" style="margin-bottom:20px"><div class="eyebrow">Sobre ${e(ctx.nombre)}</div><h2>Por qué confiar en nosotros</h2></div>
<p class="big">${e(copy.sobre)}</p><div class="why">${copy.motivos.map((m) => `<div><i>✓</i><div><b>${e(m.titulo)}</b><span>${e(m.texto)}</span></div></div>`).join('')}</div></div>
${ctx.photos.length
    ? `<div class="ph" style="background-image:url('${e(ctx.photos[1] || ctx.photos[0])}')" role="img" aria-label="${e(ctx.nombre)}"></div>`
    : `<div class="panel"><div class="big-i">${initial}</div><dl><div><dt>Negocio</dt><dd>${e(ctx.nombre)}</dd></div><div><dt>Especialidad</dt><dd>${e(ctx.sector)}</dd></div>${ctx.ciudad || ctx.direccion ? `<div><dt>Dónde</dt><dd>${e(ctx.direccion || ctx.ciudad)}</dd></div>` : ''}${tel ? `<div><dt>Contacto</dt><dd>${e(ctx.telefono)}</dd></div>` : ''}</dl></div>`}</div></section>
${gallery.length >= 2 ? `<section><div class="wrap"><div class="head"><div class="eyebrow">Galería</div><h2>Así es ${e(ctx.nombre)}</h2></div><div class="gal">${gallery.map((p) => `<div style="background-image:url('${e(p)}')" role="img" aria-label="Foto de ${e(ctx.nombre)}"></div>`).join('')}</div></div></section>` : ''}
${reviews.length ? `<section id="opiniones" style="background:var(--soft)"><div class="wrap"><div class="head"><div class="eyebrow">Opiniones reales de Google</div><h2>Lo que dicen nuestros clientes</h2>${nota ? `<div class="score"><b>${nota}</b><span>${stars(ctx.rating)} · ${ctx.resenas} reseñas</span></div>` : ''}</div>
<div class="rv">${reviews.map((r) => `<figure><span class="st">${stars(r.stars)}</span><blockquote>«${e(r.text.slice(0, 320))}${r.text.length > 320 ? '…' : ''}»</blockquote><figcaption>${e(shortName(r.name))} · Google</figcaption></figure>`).join('')}</div></div></section>` : ''}
<section class="visit" id="contacto"><div class="wrap"><div><div class="head" style="margin-bottom:10px"><div class="eyebrow">Visítanos</div><h2>Horario y ubicación</h2></div>
<p style="color:var(--muted);margin:0">${e(ctx.direccion || ctx.ciudad || '')}</p>
${ctx.horario.length ? `<ul class="hours">${ctx.horario.map((h) => `<li>${e(h)}</li>`).join('')}</ul>` : ''}
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:26px">${ctaPrimary}${ctaCall}</div></div>
<div class="map"><iframe title="Mapa de ${e(ctx.nombre)}" loading="lazy" src="https://www.google.com/maps?q=${mapQ}&output=embed"></iframe></div></div></section>
<section class="final"><div class="wrap"><h2>${e(copy.cta)}</h2><div class="ctas">${ctaPrimary}${tel ? `<a class="btn ${wa ? 'ghost' : ''}" href="tel:${e(tel)}">Llamar</a>` : ''}</div></div></section>
<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${e(ctx.nombre)}${ctx.ciudad ? ` · ${e(ctx.ciudad)}` : ''}</span><span>Demo · ${e(brand)}</span></div></footer>
${wa ? `<a class="wa-float" href="https://wa.me/${wa}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 32 32"><path d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.6c-2 0-4-.6-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.6 10.6 0 1 1 16 26.6zm5.8-7.9c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.7 8.7 0 0 1-4.3-3.8c-.3-.6.3-.5.9-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.9.4 3.7 3.7 0 0 0-1.1 2.7 6.4 6.4 0 0 0 1.4 3.4 14.6 14.6 0 0 0 5.6 4.9c2.1.9 2.9 1 4 .8a3.3 3.3 0 0 0 2.2-1.5 2.7 2.7 0 0 0 .2-1.5c-.1-.2-.3-.3-.6-.4z"/></svg></a>` : ''}
</body></html>`;
}
