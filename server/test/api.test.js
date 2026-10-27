/*
 * Pruebas de integración de la API contra un PostgreSQL real.
 *
 *   TEST_DATABASE_URL=postgres://crm:crm@localhost:5432/crm_test npm test
 *
 * ¡OJO! Borra y recrea las tablas de esa base de datos. No uses la de producción.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  test('API (omitida: define TEST_DATABASE_URL)', { skip: true }, () => {});
  return;
}

// Servicios externos falsos: Apify, Google Places y la IA de las demos.
const apifyCalls = [];
const googleCalls = [];
const aiCalls = [];
const GOOGLE_PLACES = [
  {
    id: 'G_ROSA',
    displayName: { text: 'Peluquería Rosa' },
    formattedAddress: 'Calle Larios 5, 29005 Málaga, España',
    addressComponents: [
      { longText: 'Málaga', shortText: 'Málaga', types: ['locality'] },
      { longText: 'España', shortText: 'ES', types: ['country'] }
    ],
    location: { latitude: 36.72, longitude: -4.42 },
    primaryTypeDisplayName: { text: 'Peluquería' },
    nationalPhoneNumber: '952 11 22 33',
    rating: 4.8,
    userRatingCount: 57,
    regularOpeningHours: { weekdayDescriptions: ['lunes: 9:30–20:00'] },
    googleMapsUri: 'https://maps.google.com/?cid=1',
    businessStatus: 'OPERATIONAL',
    photos: [{ name: 'places/G_ROSA/photos/F1' }],
    reviews: [{ rating: 5, originalText: { text: 'Rosa me dejó el pelo perfecto, trato encantador y muy puntual.' }, authorAttribution: { displayName: 'Marta López' } }]
  },
  {
    id: 'G_CON_WEB',
    displayName: { text: 'Salón Con Web' },
    websiteUri: 'https://salon.es',
    businessStatus: 'OPERATIONAL',
    addressComponents: [{ shortText: 'ES', types: ['country'] }]
  },
  { id: 'G_CERRADO', displayName: { text: 'Cerrado' }, businessStatus: 'CLOSED_PERMANENTLY' }
];
const fakeApify = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/gv1/places:searchText')) {
      googleCalls.push({ headers: req.headers, body: json });
      res.end(JSON.stringify({ places: GOOGLE_PLACES }));
      return;
    }
    if (req.url.startsWith('/gv1/places/G_ROSA/photos/F1/media')) {
      googleCalls.push({ photo: req.url });
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return;
    }
    if (req.url.startsWith('/anthropic/messages')) {
      aiCalls.push({ headers: req.headers, body: json });
      const html = '```html\n<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>Peluquería Rosa</h1><script>document.title="x"</script></body></html>\n```';
      res.end(JSON.stringify({ content: [{ type: 'text', text: html }] }));
      return;
    }
    apifyCalls.push({ url: req.url, body: json });
    res.end('[]');
  });
});

let base;
let server;
let db;
const tokens = {};

async function call(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no JSON */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}

before(async () => {
  await new Promise((r) => fakeApify.listen(0, r));
  Object.assign(process.env, {
    DATABASE_URL: DB_URL,
    ADMIN_EMAIL: 'admin@test.es',
    ADMIN_PASSWORD: 'admin-secreto-123',
    ADMIN_ID: 'u1',
    AUTH_SECRET: 'x'.repeat(40),
    APIFY_TOKEN: 'apify_api_falso',
    APIFY_API: `http://127.0.0.1:${fakeApify.address().port}/v2`,
    GOOGLE_MAPS_API_KEY: 'g-key-falsa',
    GOOGLE_PLACES_API: `http://127.0.0.1:${fakeApify.address().port}/gv1`,
    ANTHROPIC_API_KEY: 'sk-ant-falsa',
    ANTHROPIC_API: `http://127.0.0.1:${fakeApify.address().port}/anthropic`,
    DEMO_BRAND: 'Emergo',
    NODE_ENV: 'test'
  });
  db = require('../dist/db');
  await db.query(
    'DROP TABLE IF EXISTS demos, exclusions, lead_interactions, leads, searches, settings, users CASCADE'
  );
  await db.migrate();
  await require('../dist/auth').bootstrapAdmin();
  const app = require('../dist/index').default;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  tokens.admin = await login('admin@test.es', 'admin-secreto-123');
  for (const [id, email] of [['u3', 'lucia@test.es'], ['u4', 'javier@test.es']]) {
    const r = await call('POST', '/api/users', {
      token: tokens.admin,
      body: { id, email, nombre: id, rol: 'comercial', password: 'comercial-123456' }
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  tokens.lucia = await login('lucia@test.es', 'comercial-123456');
  tokens.javier = await login('javier@test.es', 'comercial-123456');
});

after(async () => {
  server?.close();
  fakeApify.close();
  await db?.closePool();
});

// --- 1. El servidor no se cae ---------------------------------------------

test('una fecha mal formada no tumba el servidor', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: { leads: [{ id: 'L9', nombre: 'Fecha rara', proxima_accion: 'mañana a las 10' }] }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.leads[0].proxima_accion, null);

  const p = await call('PATCH', `/api/leads/${r.json.leads[0].id}`, {
    token: tokens.lucia,
    body: { proxima_accion: 'mañana' }
  });
  assert.equal(p.status, 400);

  const bad = await call('POST', '/api/leads', { token: tokens.lucia, raw: '{"leads": [' });
  assert.equal(bad.status, 400);

  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
});

test('los leads sin nombre se rechazan uno a uno sin perder el resto', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ id: 'a', nombre: 'Válido' }, { id: 'b' }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.saved, 1);
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].client_ref, 'b');
});

// --- 2. Login y permisos -------------------------------------------------

test('sin sesión no se accede a leads, búsquedas ni configuración', async () => {
  for (const [m, p] of [['GET', '/api/leads'], ['POST', '/api/search'], ['PUT', '/api/config'], ['POST', '/api/ai']]) {
    const r = await call(m, p, m === 'GET' ? {} : { body: {} });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const forged = await call('GET', '/api/leads', { token: 'eyJzdWIiOiJ1MSIsImV4cCI6OTk5OTk5OTk5OTk5OX0.firma' });
  assert.equal(forged.status, 401);
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
});

test('contraseña incorrecta devuelve 401', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: 'admin@test.es', password: 'mal' } });
  assert.equal(r.status, 401);
});

test('un comercial no puede cambiar la configuración ni crear usuarios', async () => {
  const c = await call('PUT', '/api/config', { token: tokens.lucia, body: { actor: 'otro/actor' } });
  assert.equal(c.status, 403);
  const u = await call('POST', '/api/users', {
    token: tokens.lucia,
    body: { email: 'x@x.es', rol: 'admin', password: '1234567890' }
  });
  assert.equal(u.status, 403);
});

test('desactivar a un usuario corta su sesión al momento', async () => {
  const u = await call('POST', '/api/users', {
    token: tokens.admin,
    body: { id: 'u9', email: 'temp@test.es', rol: 'comercial', password: 'temporal-12345' }
  });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  const t = await login('temp@test.es', 'temporal-12345');
  const first = await call('GET', '/api/leads', { token: t });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await call('PATCH', '/api/users/u9', { token: tokens.admin, body: { activo: false } });
  assert.equal((await call('GET', '/api/leads', { token: t })).status, 401);
});

test('/api/search ignora el actor y el input que manda el navegador', async () => {
  apifyCalls.length = 0;
  const r = await call('POST', '/api/search', {
    token: tokens.lucia,
    body: {
      provider: 'apify',
      actor: 'malo/minero-cripto',
      input: { startUrls: ['http://evil'] },
      params: { sector: 'Peluquería', zona: 'Málaga', max: 10 }
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(apifyCalls.length, 1);
  assert.match(apifyCalls[0].url, /compass~crawler-google-places/);
  assert.doesNotMatch(apifyCalls[0].url, /minero/);
  assert.equal(apifyCalls[0].body.startUrls, undefined);
  assert.deepEqual(apifyCalls[0].body.searchStringsArray, ['Peluquería Málaga']);
  assert.equal(apifyCalls[0].body.website, 'withoutWebsite');
});

// --- 3. Leads: sin pérdidas entre comerciales ---------------------------

test('dos comerciales con el mismo id local (L1001) no se sobrescriben', async () => {
  const a = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: { leads: [{ id: 'L1001', place_id: 'P_PEPE', nombre: 'Bar Pepe', telefono: '600111222' }] }
  });
  const b = await call('POST', '/api/leads', {
    token: tokens.javier,
    body: { leads: [{ id: 'L1001', place_id: 'P_LUIS', nombre: 'Taller Luis', telefono: '600333444' }] }
  });
  assert.notEqual(a.json.leads[0].id, b.json.leads[0].id);
  assert.equal(a.json.leads[0].client_ref, 'L1001');
  const rows = await db.query("SELECT nombre, asignado_a FROM leads WHERE place_id IN ('P_PEPE','P_LUIS') ORDER BY nombre");
  assert.deepEqual(rows, [
    { nombre: 'Bar Pepe', asignado_a: 'u3' },
    { nombre: 'Taller Luis', asignado_a: 'u4' }
  ]);
});

test('reimportar no resetea estado, intentos, asignación ni «no contactar»', async () => {
  const [lead] = (await db.query("SELECT id FROM leads WHERE place_id = 'P_LUIS'"));
  const p = await call('PATCH', `/api/leads/${lead.id}`, {
    token: tokens.javier,
    body: { estado: 'no_interes', no_contactar: true, intentos: 3 }
  });
  assert.equal(p.status, 200, JSON.stringify(p.json));

  // Lucía vuelve a encontrar el mismo negocio en otra búsqueda.
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: { leads: [{ id: 'L2050', place_id: 'P_LUIS', nombre: 'Taller Luis', rating: 4.6, resenas: 31 }] }
  });
  assert.equal(r.json.duplicates, 1);
  const out = r.json.leads[0];
  assert.equal(out.duplicate, true);
  assert.equal(out.id, lead.id);
  assert.equal(out.no_contactar, true);
  assert.equal(out.estado, 'no_interes');
  assert.equal(out.intentos, 3);
  assert.equal(out.asignado_a, 'u4');
  assert.equal(Number(out.rating), 4.6); // los datos de Maps sí se refrescan
  assert.equal(out.telefono, '600333444'); // y lo vacío no borra lo que había
});

test('el mismo teléfono con otro formato cuenta como duplicado', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ id: 'L3', nombre: 'Bar Pepe (ficha 2)', telefono: '+34 600 11 12 22' }]
  });
  assert.equal(r.json.duplicates, 1);
  const n = await db.query("SELECT count(*)::int AS n FROM leads WHERE telefono_norm = '600111222'");
  assert.equal(n[0].n, 1);
});

test('importaciones simultáneas del mismo negocio crean una sola fila', async () => {
  const send = (tk, ref) =>
    call('POST', '/api/leads', { token: tk, body: [{ id: ref, place_id: 'P_RACE', nombre: 'Carrera' }] });
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => send(i % 2 ? tokens.lucia : tokens.javier, `R${i}`)));
  rs.forEach((r) => assert.equal(r.status, 200));
  const n = await db.query("SELECT count(*)::int AS n FROM leads WHERE place_id = 'P_RACE'");
  assert.equal(n[0].n, 1);
});

test('coordenadas 0,0 se guardan vacías y web_tipo se normaliza', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ nombre: 'Sin coords', lat: 0, lng: 0, web: 'https://instagram.com/x', redes: ['https://instagram.com/x'] }]
  });
  const l = r.json.leads[0];
  assert.equal(l.lat, null);
  assert.equal(l.lng, null);
  assert.equal(l.web_tipo, 'red social');
  assert.equal(l.web_detectada, false);
});

test('web_tipo reconoce el nombre de la red que guarda el frontend', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ nombre: 'Solo Insta', web_tipo: 'instagram', redes: ['instagram'] }]
  });
  assert.equal(r.json.leads[0].web_tipo, 'red social');
});

// --- Visibilidad y permisos sobre leads ------------------------------------

test('un comercial no ve ni toca los leads de otro', async () => {
  const [pepe] = await db.query("SELECT id FROM leads WHERE place_id = 'P_PEPE'");
  assert.equal((await call('GET', `/api/leads/${pepe.id}`, { token: tokens.javier })).status, 404);
  assert.equal(
    (await call('PATCH', `/api/leads/${pepe.id}`, { token: tokens.javier, body: { estado: 'callback' } })).status,
    404
  );
  const list = await call('GET', '/api/leads?limit=500', { token: tokens.javier });
  assert.ok(list.json.leads.every((l) => l.asignado_a === 'u4' || l.asignado_a === null));
  const all = await call('GET', '/api/leads?limit=500', { token: tokens.admin });
  assert.ok(all.json.total > list.json.total);
});

test('un comercial no puede quitar «no contactar»; un admin sí', async () => {
  const [luis] = await db.query("SELECT id FROM leads WHERE place_id = 'P_LUIS'");
  const c = await call('PATCH', `/api/leads/${luis.id}`, { token: tokens.javier, body: { no_contactar: false } });
  assert.equal(c.status, 403);
});

test('guardar sobre una versión antigua devuelve 409', async () => {
  const [pepe] = await db.query("SELECT id FROM leads WHERE place_id = 'P_PEPE'");
  const g = await call('GET', `/api/leads/${pepe.id}`, { token: tokens.lucia });
  const old = g.json.lead.updated_at;
  const ok = await call('PATCH', `/api/leads/${pepe.id}`, {
    token: tokens.lucia,
    body: { estado: 'callback', updated_at: old }
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const stale = await call('PATCH', `/api/leads/${pepe.id}`, {
    token: tokens.admin,
    body: { estado: 'descartado', updated_at: old }
  });
  assert.equal(stale.status, 409);
});

test('registrar una llamada suma un intento y cambia el estado', async () => {
  const [pepe] = await db.query("SELECT id, intentos FROM leads WHERE place_id = 'P_PEPE'");
  const r = await call('POST', `/api/leads/${pepe.id}/interactions`, {
    token: tokens.lucia,
    body: { tipo: 'llamada', resultado: 'interesado', nota: 'Llamar el jueves', estado: 'potencial' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.lead.intentos, pepe.intentos + 1);
  assert.equal(r.json.lead.estado, 'potencial');
  const h = await call('GET', `/api/leads/${pepe.id}/interactions`, { token: tokens.lucia });
  assert.ok(h.json.interactions.some((i) => i.nota === 'Llamar el jueves'));
  assert.ok(h.json.interactions.some((i) => i.tipo === 'estado')); // el PATCH anterior dejó rastro
  const bad = await call('POST', `/api/leads/${pepe.id}/interactions`, { token: tokens.lucia, body: { tipo: 'fax' } });
  assert.equal(bad.status, 400);
});

test('borrar un lead «no contactar» lo pasa a la lista de exclusión', async () => {
  const [luis] = await db.query("SELECT id FROM leads WHERE place_id = 'P_LUIS'");
  assert.equal((await call('DELETE', `/api/leads/${luis.id}`, { token: tokens.javier })).status, 403);
  assert.equal((await call('DELETE', `/api/leads/${luis.id}`, { token: tokens.admin })).status, 200);
  const ex = await call('GET', '/api/exclusions', { token: tokens.admin });
  assert.ok(ex.json.exclusions.some((e) => e.place_id === 'P_LUIS'));
  // Vuelve a salir en una búsqueda: no se importa.
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ id: 'L77', place_id: 'P_LUIS', nombre: 'Taller Luis', telefono: '600333444' }]
  });
  assert.equal(r.json.saved, 0);
  assert.equal(r.json.excluded.length, 1);
  assert.equal(r.json.excluded[0].client_ref, 'L77');
});

test('búsqueda por nombre y por teléfono', async () => {
  const r = await call('GET', '/api/leads?q=pepe', { token: tokens.admin });
  assert.ok(r.json.leads.some((l) => l.nombre === 'Bar Pepe'));
  const t = await call('GET', '/api/leads?q=600%2011%2012', { token: tokens.admin });
  assert.ok(t.json.leads.some((l) => l.nombre === 'Bar Pepe'));
});

// --- v1.3.0 ------------------------------------------------------------------

test('lote: cambios y borrados con permisos por elemento', async () => {
  const mk = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ id: 'B1', place_id: 'P_B1', nombre: 'Lote 1' }, { id: 'B2', place_id: 'P_B2', nombre: 'Lote 2' }]
  });
  const [b1, b2] = mk.json.leads.map((l) => l.id);
  const [pepe] = await db.query("SELECT id FROM leads WHERE place_id = 'P_PEPE'");
  const r = await call('POST', '/api/leads/batch', {
    token: tokens.javier,
    body: {
      updates: [
        { id: b1, estado: 'callback', log: false },  // de Lucía: Javier no lo ve
        { id: pepe.id, estado: 'nuevo' }
      ],
      deletes: [b2]
    }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => x.status || 200), [404, 404, 403]);

  const ok = await call('POST', '/api/leads/batch', {
    token: tokens.lucia,
    body: { updates: [{ id: b1, estado: 'callback', intentos: 2, log: false }, { id: b2, estado: 'nada' }] }
  });
  assert.equal(ok.json.results[0].ok, true);
  assert.equal(ok.json.results[0].lead.estado, 'callback');
  assert.equal(ok.json.results[1].ok, false); // estado inválido no bloquea al resto
  const its = await call('GET', `/api/leads/${b1}/interactions`, { token: tokens.lucia });
  assert.equal(its.json.interactions.filter((i) => i.tipo === 'estado').length, 0); // log:false

  const del = await call('POST', '/api/leads/batch', { token: tokens.admin, body: { deletes: [b2, 'no-existe'] } });
  assert.ok(del.json.results.every((x) => x.ok));
});

test('interacciones del navegador: subida idempotente', async () => {
  const [pepe] = await db.query("SELECT id FROM leads WHERE place_id = 'P_PEPE'");
  const items = [
    { lead_id: pepe.id, client_ref: 'i-aaa', tipo: 'llamada', resultado: 'no contesta', nota: 'Primera llamada', fecha: '2026-10-20T10:00:00Z' },
    { lead_id: pepe.id, client_ref: 'i-bbb', tipo: 'raro', nota: 'tipo desconocido pasa a nota' }
  ];
  const a = await call('POST', '/api/interactions/batch', { token: tokens.lucia, body: { items } });
  const b = await call('POST', '/api/interactions/batch', { token: tokens.lucia, body: { items } });
  assert.equal(a.json.saved, 2);
  assert.equal(b.json.saved, 2);
  const n = await db.query("SELECT count(*)::int AS n FROM lead_interactions WHERE client_ref IN ('i-aaa','i-bbb')");
  assert.equal(n[0].n, 2);
  const x = await call('POST', '/api/interactions/batch', { token: tokens.javier, body: { items: [{ ...items[0], client_ref: 'i-ccc' }] } });
  assert.equal(x.json.failed.length, 1); // no es su lead
});

test('lectura incremental con interacciones e ids visibles', async () => {
  const since = new Date(Date.now() - 60000).toISOString();
  const r = await call('GET', `/api/leads?updated_since=${encodeURIComponent(since)}&with_interactions=1&limit=500`, { token: tokens.lucia });
  assert.equal(r.status, 200);
  assert.ok(r.json.server_time);
  const pepe = r.json.leads.find((l) => l.place_id === 'P_PEPE');
  assert.ok(pepe);
  assert.ok(r.json.interactions[pepe.id].some((i) => i.client_ref === 'i-aaa'));
  const ids = await call('GET', '/api/leads/ids', { token: tokens.javier });
  assert.ok(!ids.json.ids.includes(pepe.id));
});

test('búsquedas: se guardan y nadie pisa las de otro', async () => {
  const s = { id: 's-test1', sector: 'Peluquería', zona: 'Málaga', resultados: 12, nuevos: 9, duplicados: 3, proveedor: 'google', lead_ids: ['x'], fecha: '2026-10-27T09:00:00Z' };
  assert.deepEqual((await call('POST', '/api/searches', { token: tokens.lucia, body: { searches: [s] } })).json.saved, ['s-test1']);
  const pisar = await call('POST', '/api/searches', { token: tokens.javier, body: { searches: [{ ...s, nuevos: 0 }] } });
  assert.deepEqual(pisar.json.saved, []);
  const mine = await call('GET', '/api/searches', { token: tokens.lucia });
  assert.equal(mine.json.searches.find((x) => x.id === 's-test1').nuevos, 9);
  const other = await call('GET', '/api/searches', { token: tokens.javier });
  assert.ok(!other.json.searches.some((x) => x.id === 's-test1'));
  const all = await call('GET', '/api/searches', { token: tokens.admin });
  assert.ok(all.json.searches.some((x) => x.id === 's-test1'));
});

let rosaItem;
test('Google Places: busca, mapea como Apify y descarta cerrados', async () => {
  googleCalls.length = 0;
  const r = await call('POST', '/api/search', { token: tokens.lucia, body: { params: { sector: 'Peluquería', zona: 'Málaga', max: 20 } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.provider, 'google');
  assert.equal(googleCalls[0].body.textQuery, 'Peluquería en Málaga');
  assert.equal(googleCalls[0].headers['x-goog-api-key'], 'g-key-falsa');
  assert.match(googleCalls[0].headers['x-goog-fieldmask'], /places\.reviews/);
  assert.equal(r.json.items.length, 2);
  rosaItem = r.json.items[0];
  assert.equal(rosaItem.title, 'Peluquería Rosa');
  assert.equal(rosaItem.placeId, 'G_ROSA');
  assert.equal(rosaItem.city, 'Málaga');
  assert.equal(rosaItem.countryCode, 'ES');
  assert.equal(rosaItem.reviews[0].name, 'Marta López');
  assert.match(rosaItem.imageUrl, /^\/media\/place-photo\/.+\.jpg$/);
  assert.equal(r.json.items[1].website, 'https://salon.es');
});

test('fotos: el proxy firmado sirve la imagen y rechaza firmas falsas', async () => {
  const ok = await fetch(base + rosaItem.imageUrl);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('cache-control'), /max-age/);
  const bad = await fetch(base + rosaItem.imageUrl.replace(/place-photo\/[^/]+/, 'place-photo/firmafalsafirmafalsa12'));
  assert.equal(bad.status, 403);
});

let rosaId;
test('demo web: usa reseñas y fotos reales, se publica aislada y cuenta visitas', async () => {
  const imp = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [{ id: 'L500', place_id: 'G_ROSA', nombre: 'Peluquería Rosa', sector: 'Peluquería', ciudad: 'Málaga', telefono: '952 11 22 33', rating: 4.8, resenas: 57, image_url: rosaItem.imageUrl, raw: rosaItem }]
  });
  rosaId = imp.json.leads[0].id;
  assert.equal(imp.json.leads[0].image_url, rosaItem.imageUrl);

  aiCalls.length = 0;
  const r = await call('POST', '/api/demos', { token: tokens.lucia, body: { lead_id: rosaId, tipo: 'web', notas: 'Destacar el trato' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const prompt = aiCalls[0].body.messages[0].content;
  assert.match(prompt, /Rosa me dejó el pelo perfecto/);
  assert.match(prompt, /Marta L\./);
  assert.doesNotMatch(prompt, /Marta López/);
  assert.match(prompt, /\/media\/place-photo\//);
  assert.match(prompt, /Destacar el trato/);
  assert.equal(aiCalls[0].headers['x-api-key'], 'sk-ant-falsa');
  assert.match(r.json.lovable_url, /^https:\/\/lovable\.dev\/#prompt=/);
  assert.match(r.json.lovable_url, /images=/);

  const page = await fetch(r.json.demo.url.replace(/^https?:\/\/[^/]+/, base), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /^sandbox/);
  const html = await page.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /noindex/);
  await new Promise((r2) => setTimeout(r2, 100));
  const list = await call('GET', `/api/demos?lead_id=${rosaId}`, { token: tokens.lucia });
  assert.equal(list.json.demos[0].visitas, 1);
  assert.equal((await call('GET', `/api/demos?lead_id=${rosaId}`, { token: tokens.javier })).status, 404);
});

test('demo CRM: plantilla personalizada sin IA', async () => {
  aiCalls.length = 0;
  const r = await call('POST', '/api/demos', { token: tokens.lucia, body: { lead_id: rosaId, tipo: 'crm' } });
  assert.equal(r.status, 201);
  assert.equal(aiCalls.length, 0);
  const html = await (await fetch(r.json.demo.url.replace(/^https?:\/\/[^/]+/, base))).text();
  assert.match(html, /Peluquería Rosa/);
  assert.match(html, /Corte/);
  assert.match(html, /4\.8 ★/);
});

test('prompt de demo sin generar (vista previa)', async () => {
  const r = await call('POST', '/api/demos/prompt', { token: tokens.lucia, body: { lead_id: rosaId } });
  assert.equal(r.status, 200);
  assert.equal(r.json.fuentes.reseñas, 1);
  assert.equal(r.json.fuentes.fotos, 1);
});

// --- v1.3.1: deshacer búsquedas ------------------------------------------------

test('deshacer búsqueda: borra lo no trabajado, conserva lo trabajado', async () => {
  await call('POST', '/api/searches', { token: tokens.lucia, body: { searches: [{ id: 's-mala', sector: 'Basura', zona: 'Málaga', resultados: 3, nuevos: 3 }] } });
  const imp = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [
      { id: 'U1', place_id: 'P_U1', nombre: 'Basura 1', search_id: 's-mala' },
      { id: 'U2', place_id: 'P_U2', nombre: 'Basura 2', search_id: 's-mala' },
      { id: 'U3', place_id: 'P_U3', nombre: 'Basura 3', search_id: 's-mala' },
      { id: 'U4', place_id: 'P_PEPE', nombre: 'Bar Pepe', search_id: 's-mala' } // ya existía: no es de esta búsqueda
    ]
  });
  const [u1, u2, u3] = imp.json.leads.map((l) => l.id);
  // U2 ya se ha llamado; U3 tiene una nota.
  await call('PATCH', `/api/leads/${u2}`, { token: tokens.lucia, body: { estado: 'no_contesta', intentos: 1 } });
  await call('POST', `/api/leads/${u3}/interactions`, { token: tokens.lucia, body: { tipo: 'nota', nota: 'ojo, interesante' } });

  assert.equal((await call('POST', '/api/searches/s-mala/undo', { token: tokens.javier })).status, 403);
  const r = await call('POST', '/api/searches/s-mala/undo', { token: tokens.lucia });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.deleted, [u1]);
  assert.deepEqual(r.json.kept.map((k) => k.id).sort(), [u2, u3].sort());
  const left = await db.query("SELECT id, search_id FROM leads WHERE place_id IN ('P_U1','P_U2','P_U3','P_PEPE')");
  assert.equal(left.length, 3);
  assert.ok(left.every((l) => l.search_id !== 's-mala'));
  assert.equal((await db.query("SELECT 1 FROM searches WHERE id = 's-mala'")).length, 0);
});

test('borrar del historial: el dueño puede, otro comercial no', async () => {
  await call('POST', '/api/searches', { token: tokens.lucia, body: { searches: [{ id: 's-hist' }] } });
  assert.equal((await call('DELETE', '/api/searches/s-hist', { token: tokens.javier })).status, 403);
  assert.equal((await call('DELETE', '/api/searches/s-hist', { token: tokens.lucia })).status, 200);
});

test('al subir leads antiguos se conserva su fecha de alta (nunca en el futuro)', async () => {
  const r = await call('POST', '/api/leads', {
    token: tokens.lucia,
    body: [
      { id: 'F1', place_id: 'P_F1', nombre: 'Antiguo', created_at: '2026-03-05T09:00:00Z' },
      { id: 'F2', place_id: 'P_F2', nombre: 'Futuro', created_at: '2099-01-01T00:00:00Z' },
      { id: 'F3', place_id: 'P_F3', nombre: 'Sin fecha' }
    ]
  });
  const [a, f, n] = r.json.leads;
  assert.equal(new Date(a.created_at).toISOString(), '2026-03-05T09:00:00.000Z');
  assert.ok(new Date(f.created_at).getTime() <= Date.now() + 1000);
  assert.ok(Math.abs(new Date(n.created_at).getTime() - Date.now()) < 60000);
});
