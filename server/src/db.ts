import fs from 'fs';
import path from 'path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { env } from './env';

let pool: Pool | null = null;

export function dbEnabled(): boolean {
  return !!env.databaseUrl && env.databaseUrl.trim().length > 0;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      // Railway y la mayoría de PaaS requieren TLS salvo en red interna.
      ssl: /localhost|127\.0\.0\.1|@db:|host=db/.test(env.databaseUrl)
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never);
  return res.rows;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  if (!dbEnabled()) return;
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
}

export async function dbHealthy(): Promise<boolean> {
  if (!dbEnabled()) return false;
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
