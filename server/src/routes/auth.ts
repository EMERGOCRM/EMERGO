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

    const rows = await query<AuthUser & { pass_hash: string; activo: boolean }>(
      'SELECT id, email, nombre, rol, pass_hash, activo FROM users WHERE lower(email) = $1',
      [email]
    );
    const u = rows[0];
    // Se verifica siempre (con un hash ficticio si no existe) para no revelar
    // por tiempo de respuesta qué emails están dados de alta.
    const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH);
    if (!u || !ok || !u.activo) throw new HttpError(401, 'Email o contraseña incorrectos');

    const user: AuthUser = { id: u.id, email: u.email, nombre: u.nombre, rol: u.rol };
    res.json({ ok: true, ...issueToken(user), user });
  })
);

/** Rutas que requieren sesión. */
export const privateAuth = Router();

privateAuth.get('/auth/me', (req: Request, res: Response) => {
  res.json({ ok: true, user: req.user });
});

const USER_COLS = 'id, email, nombre, rol, activo, created_at';

/** GET /api/users (admin y supervisor) */
privateAuth.get(
  '/users',
  requireRole('admin', 'supervisor'),
  ah(async (_req, res) => {
    const rows = await query(`SELECT ${USER_COLS} FROM users ORDER BY created_at`);
    res.json({ users: rows });
  })
);

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
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Email no válido');
    const nombre = (b.nombre !== undefined ? strictStr(b, 'nombre', 120) : null) || email;
    const rol = strictEnum(b, 'rol', ROLES);
    const password = checkPasswordPolicy(b.password);
    const id = (b.id !== undefined ? strictStr(b, 'id', 60) : null) || `u_${crypto.randomUUID().slice(0, 8)}`;
    if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'El id solo admite letras, números, punto, guion y guion bajo');

    const dup = await query('SELECT 1 FROM users WHERE id = $1 OR lower(email) = $2', [id, email]);
    if (dup.length) throw new HttpError(409, 'Ya existe un usuario con ese id o email');

    const rows = await query(
      `INSERT INTO users (id, email, nombre, rol, pass_hash, activo)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING ${USER_COLS}`,
      [id, email, nombre, rol, hashPassword(password)]
    );
    res.status(201).json({ user: rows[0] });
  })
);

/** PATCH /api/users/:id (admin)  { nombre?, rol?, activo?, password? } */
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
    if ('nombre' in b) add('nombre', strictStr(b, 'nombre', 120));
    if ('rol' in b) add('rol', strictEnum(b, 'rol', ROLES));
    if ('activo' in b) add('activo', strictBool(b, 'activo'));
    if ('password' in b) add('pass_hash', hashPassword(checkPasswordPolicy(b.password)));
    if (!sets.length) throw new HttpError(400, 'Nada que actualizar');

    if (req.params.id === req.user?.id && (b.activo === false || ('rol' in b && b.rol !== 'admin'))) {
      throw new HttpError(400, 'No puedes desactivarte ni quitarte el rol de admin a ti mismo');
    }
    args.push(req.params.id);
    const rows = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING ${USER_COLS}`,
      args
    );
    if (!rows.length) throw new HttpError(404, 'Usuario no encontrado');
    res.json({ user: rows[0] });
  })
);

export { requireAuth };
