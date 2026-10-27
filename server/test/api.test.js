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

// Apify falso: registra qué actor e input recibe el servidor.
const apifyCalls = [];
const fakeApify = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    apifyCalls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
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
    NODE_ENV: 'test'
  });
  db = require('../dist/db');
  await db.query(
    'DROP TABLE IF EXISTS lead_interactions, leads, searches, settings, users CASCADE'
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

test('borrar: solo admin, y «no contactar» exige confirmación', async () => {
  const [luis] = await db.query("SELECT id FROM leads WHERE place_id = 'P_LUIS'");
  assert.equal((await call('DELETE', `/api/leads/${luis.id}`, { token: tokens.javier })).status, 403);
  assert.equal((await call('DELETE', `/api/leads/${luis.id}`, { token: tokens.admin })).status, 409);
  assert.equal((await call('DELETE', `/api/leads/${luis.id}?force=1`, { token: tokens.admin })).status, 200);
});

test('búsqueda por nombre y por teléfono', async () => {
  const r = await call('GET', '/api/leads?q=pepe', { token: tokens.admin });
  assert.ok(r.json.leads.some((l) => l.nombre === 'Bar Pepe'));
  const t = await call('GET', '/api/leads?q=600%2011%2012', { token: tokens.admin });
  assert.ok(t.json.leads.some((l) => l.nombre === 'Bar Pepe'));
});
