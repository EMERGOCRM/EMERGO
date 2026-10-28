import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query, dbEnabled } from '../db';
import { ah, HttpError, makeRateLimiter } from '../http';
import {
  AuthUser,
  checkPasswordPolicy,
  hashPassword,
  issueToken,
  requireAuth,
  requireRole,
  verifyPassword
} from '../auth';
import { ROLES, strictBool, strictEnum, strictStr } from '../validate';

/** Rutas públicas: solo el login. */
export const publicAuth = Router();

const loginLimit = makeRateLimiter(10 * 60 * 1000);
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** POST /api/auth/login  { email, password } -> { token, expires_at, user } */
publicAuth.post(
  '/auth/login',
  ah(async (req: Request, res: Response) => {
    if (!dbEnabled()) throw new HttpError(503, 'Base de datos no configurada (DATABASE_URL)');
    if (!loginLimit(`ip:${req.ip}`, 10)) {
      throw new HttpError(429, 'Demasiados intentos de acceso. Espera 10 minutos.');
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) throw new HttpError(400, 'Indica email y contraseña');

    const rows = await query<AuthUser & { pass_hash: string; activo: boolean; desk: string }>(
      'SELECT id, email, nombre, rol, desk, pass_hash, activo FROM users WHERE lower(email) = $1',
      [email]
    );
    const u = rows[0];
    // Se verifica siempre (con un hash ficticio si no existe) para no revelar
    // por tiempo de respuesta qué emails están dados de alta.
    const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH);
    if (!u || !ok || !u.activo) throw new HttpError(401, 'Email o contraseña incorrectos');

    const user: AuthUser = { id: u.id, email: u.email, nombre: u.nombre, rol: u.rol };
    res.json({ ok: true, ...issueToken(user), user: { ...user, desk: u.desk, activo: u.activo } });
  })
);

/** Rutas que requieren sesión. */
export const privateAuth = Router();

const USER_COLS = 'id, email, nombre, rol, desk, activo, created_at, updated_at';
const DESKS = ['leads', 'clientes', 'todos'] as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

privateAuth.get(
  '/auth/me',
  ah(async (req, res) => {
    const rows = await query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.user!.id]);
    res.json({ ok: true, user: rows[0] || req.user });
  })
);

/** POST /api/auth/password  { actual, nueva }  Cada usuario cambia su propia contraseña. */
privateAuth.post(
  '/auth/password',
  ah(async (req, res) => {
    const actual = String(req.body?.actual || '');
    const nueva = checkPasswordPolicy(req.body?.nueva);
    const rows = await query<{ pass_hash: string }>('SELECT pass_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!rows.length || !verifyPassword(actual, rows[0].pass_hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
    await query('UPDATE users SET pass_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(nueva), req.user!.id]);
    res.json({ ok: true });
  })
);

/**
 * GET /api/users
 * Admin y supervisor reciben la ficha completa; el resto solo lo necesario
 * para mostrar nombres (sin emails).
 */
privateAuth.get(
  '/users',
  ah(async (req, res) => {
    const full = req.user!.rol === 'admin' || req.user!.rol === 'supervisor';
    const cols = full ? USER_COLS : 'id, nombre, rol, desk, activo';
    const rows = await query(`SELECT ${cols} FROM users ORDER BY created_at`);
    res.json({ users: rows });
  })
);

async function activeAdminsExcept(id: string): Promise<number> {
  const r = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM users WHERE rol = 'admin' AND activo AND id <> $1",
    [id]
  );
  return Number(r[0]?.n || 0);
}

/**
 * POST /api/users (admin)  { id?, email, nombre, rol, password }
 * Usa el mismo id que en el frontend (u1, u2…) para que las asignaciones cuadren.
 */
privateAuth.post(
  '/users',
  requireRole('admin'),
  ah(async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const email = strictStr(b, 'email', 200)?.toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Email no válido');
    const nombre = (b.nombre !== undefined ? strictStr(b, 'nombre', 120) : null) || email;
    const rol = strictEnum(b, 'rol', ROLES);
    const desk = b.desk !== undefined ? strictEnum(b, 'desk', DESKS) : rol === 'soporte' ? 'clientes' : rol === 'admin' ? 'todos' : 'leads';
    const activo = b.activo !== undefined ? strictBool(b, 'activo') : true;
    const password = checkPasswordPolicy(b.password);
    const id = (b.id !== undefined ? strictStr(b, 'id', 60) : null) || `u_${crypto.randomUUID().slice(0, 8)}`;
    if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'El id solo admite letras, números, punto, guion y guion bajo');

    const dup = await query('SELECT 1 FROM users WHERE id = $1 OR lower(email) = $2', [id, email]);
    if (dup.length) throw new HttpError(409, 'Ya existe un usuario con ese id o email');

    const rows = await query(
      `INSERT INTO users (id, email, nombre, rol, desk, pass_hash, activo)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${USER_COLS}`,
      [id, email, nombre, rol, desk, hashPassword(password), activo]
    );
    res.status(201).json({ user: rows[0] });
  })
);

/** PATCH /api/users/:id (admin)  { nombre?, email?, rol?, desk?, activo?, password? } */
privateAuth.patch(
  '/users/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if ('nombre' in b) {
      const n = strictStr(b, 'nombre', 120);
      if (!n) throw new HttpError(400, 'El nombre no puede estar vacío');
      add('nombre', n);
    }
    if ('email' in b) {
      const em = strictStr(b, 'email', 200)?.toLowerCase();
      if (!em || !EMAIL_RE.test(em)) throw new HttpError(400, 'Email no válido');
      const dup = await query('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [em, req.params.id]);
      if (dup.length) throw new HttpError(409, 'Ese email ya lo usa otro usuario');
      add('email', em);
    }
    if ('rol' in b) add('rol', strictEnum(b, 'rol', ROLES));
    if ('desk' in b) add('desk', strictEnum(b, 'desk', DESKS));
    if ('activo' in b) add('activo', strictBool(b, 'activo'));
    if ('password' in b) add('pass_hash', hashPassword(checkPasswordPolicy(b.password)));
    if (!sets.length) throw new HttpError(400, 'Nada que actualizar');

    if (req.params.id === req.user?.id && (b.activo === false || ('rol' in b && b.rol !== 'admin'))) {
      throw new HttpError(400, 'No puedes desactivarte ni quitarte el rol de admin a ti mismo');
    }
    if (b.activo === false || ('rol' in b && b.rol !== 'admin')) {
      const cur = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [req.params.id]);
      if (cur[0]?.rol === 'admin' && (await activeAdminsExcept(req.params.id)) === 0) {
        throw new HttpError(400, 'Debe quedar al menos un administrador activo');
      }
    }
    sets.push('updated_at = now()');
    args.push(req.params.id);
    const rows = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING ${USER_COLS}`,
      args
    );
    if (!rows.length) throw new HttpError(404, 'Usuario no encontrado');
    res.json({ user: rows[0] });
  })
);

/**
 * DELETE /api/users/:id?reasignar_a=uX (admin)
 * Sus leads pasan al usuario indicado o quedan sin asignar. El historial
 * de llamadas y notas se conserva.
 */
privateAuth.delete(
  '/users/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = req.params.id;
    if (id === req.user?.id) throw new HttpError(400, 'No puedes borrar tu propio usuario');
    const cur = await query<{ rol: string }>('SELECT rol FROM users WHERE id = $1', [id]);
    if (!cur.length) throw new HttpError(404, 'Usuario no encontrado');
    if (cur[0].rol === 'admin' && (await activeAdminsExcept(id)) === 0) {
      throw new HttpError(400, 'Debe quedar al menos un administrador activo');
    }
    const to = typeof req.query.reasignar_a === 'string' && req.query.reasignar_a ? req.query.reasignar_a : null;
    if (to) {
      if (to === id) throw new HttpError(400, 'Elige otro usuario para reasignar');
      const t = await query('SELECT 1 FROM users WHERE id = $1 AND activo', [to]);
      if (!t.length) throw new HttpError(400, 'El usuario al que reasignar no existe o está inactivo');
    }
    const moved = await query<{ id: string }>(
      'UPDATE leads SET asignado_a = $1, updated_at = now() WHERE asignado_a = $2 RETURNING id',
      [to, id]
    );
    await query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true, leads_reasignados: moved.length, reasignar_a: to });
  })
);

export { requireAuth };
