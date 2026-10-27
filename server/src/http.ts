import { Request, Response, NextFunction, RequestHandler } from 'express';

/** Error con código HTTP controlado: el manejador global lo devuelve tal cual. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Envuelve un handler async para que cualquier excepción llegue al manejador
 * de errores de Express. Sin esto, Express 4 deja la promesa rechazada sin
 * capturar y Node cierra el proceso entero.
 */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Rate limit sencillo en memoria, por clave (usuario o IP). */
export function makeRateLimiter(windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return function allow(key: string, max: number): boolean {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    const cur = hits.get(key);
    if (!cur || cur.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    if (cur.count >= max) return false;
    cur.count += 1;
    return true;
  };
}

/** Traduce errores de PostgreSQL a respuestas HTTP comprensibles. */
export function pgErrorToHttp(err: { code?: string; message?: string }): HttpError | null {
  const code = err.code || '';
  if (code === '23505') return new HttpError(409, 'Registro duplicado');
  if (code === '23503') return new HttpError(409, 'Referencia a un registro que no existe');
  if (code.startsWith('22') || code === '23502' || code === '23514') {
    return new HttpError(400, 'Dato no válido para la base de datos');
  }
  return null;
}
