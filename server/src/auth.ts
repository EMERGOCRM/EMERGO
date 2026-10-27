import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from './env';
import { dbEnabled, query } from './db';
import { HttpError } from './http';
import { Rol } from './validate';

export interface AuthUser {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

// --- Secreto de firma -----------------------------------------------------

let secret = env.authSecret.trim();
if (secret.length < 32) {
  secret = crypto.randomBytes(48).toString('hex');
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] AUTH_SECRET no definido o demasiado corto: se usa uno aleatorio. ' +
      'Las sesiones se cerrarán en cada reinicio. Define AUTH_SECRET (32+ caracteres).'
  );
}

// --- Contraseñas (scrypt, sin dependencias) -------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

export function checkPasswordPolicy(password: unknown): string {
  if (typeof password !== 'string' || password.length < 10) {
    throw new HttpError(400, 'La contraseña debe tener al menos 10 caracteres');
  }
  if (password.length > 200) throw new HttpError(400, 'Contraseña demasiado larga');
  return password;
}

// --- Tokens de sesión firmados (HMAC-SHA256) ------------------------------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Firma corta para URLs públicas (fotos): evita que usen el proxy con tu clave. */
export function signValue(value: string): string {
  return sign(`v:${value}`).slice(0, 22);
}

export function checkSignedValue(value: string, sig: string): boolean {
  const exp = signValue(value);
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}

export function issueToken(user: AuthUser): { token: string; expires_at: string } {
  const exp = Date.now() + Math.max(1, env.sessionHours) * 3600 * 1000;
  const payload = b64url(JSON.stringify({ sub: user.id, exp }));
  return { token: `${payload}.${sign(payload)}`, expires_at: new Date(exp).toISOString() };
}

function readToken(token: string): { sub: string; exp: number } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.sub !== 'string' || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// --- Middleware -----------------------------------------------------------

/**
 * Exige un token válido. Se comprueba en la base de datos que el usuario
 * sigue activo, así desactivar a alguien corta su acceso al momento.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!dbEnabled()) throw new HttpError(503, 'Base de datos no configurada (DATABASE_URL)');
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Inicia sesión en el backend');
    const data = readToken(token);
    if (!data) throw new HttpError(401, 'Sesión no válida o caducada');
    const rows = await query<AuthUser & { activo: boolean }>(
      'SELECT id, email, nombre, rol, activo FROM users WHERE id = $1',
      [data.sub]
    );
    if (!rows.length || !rows[0].activo) throw new HttpError(401, 'Usuario desactivado');
    const { id, email, nombre, rol } = rows[0];
    req.user = { id, email, nombre, rol };
    next();
  } catch (e) {
    next(e);
  }
}

export function requireRole(...roles: Rol[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      next(new HttpError(403, 'No tienes permiso para esta acción'));
      return;
    }
    next();
  };
}

/** Admin y supervisor ven y reasignan todos los leads. */
export function seesAll(user?: AuthUser): boolean {
  return !!user && (user.rol === 'admin' || user.rol === 'supervisor');
}

// --- Primer administrador -------------------------------------------------

export async function bootstrapAdmin(): Promise<void> {
  if (!dbEnabled()) return;
  const email = env.adminEmail.trim().toLowerCase();
  const pass = env.adminPassword;
  if (email && pass) {
    const exists = await query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (!exists.length) {
      if (pass.length < 10) {
        console.error('[auth] ADMIN_PASSWORD debe tener al menos 10 caracteres; no se crea el admin.');
        return;
      }
      await query(
        `INSERT INTO users (id, email, nombre, rol, pass_hash, activo)
         VALUES ($1, $2, $3, 'admin', $4, true)
         ON CONFLICT (id) DO NOTHING`,
        [env.adminId, email, env.adminName, hashPassword(pass)]
      );
      console.log(`[auth] administrador inicial creado: ${email} (id ${env.adminId})`);
    }
    return;
  }
  const count = await query<{ n: string }>('SELECT count(*)::text AS n FROM users');
  if (count[0]?.n === '0') {
    console.warn('[auth] No hay usuarios. Define ADMIN_EMAIL y ADMIN_PASSWORD para crear el administrador.');
  }
}
