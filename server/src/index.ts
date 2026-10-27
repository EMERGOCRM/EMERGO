import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { env, hasAI } from './env';
import { migrate, dbEnabled, dbHealthy, closePool } from './db';
import searchRoutes from './routes/search';
import leadRoutes from './routes/leads';
import configRoutes from './routes/config';
import aiRoutes, { publicAi } from './routes/ai';
import { publicAuth, privateAuth, requireAuth } from './routes/auth';
import { bootstrapAdmin } from './auth';
import { HttpError, pgErrorToHttp } from './http';

const app = express();

app.disable('x-powered-by');
// Railway pone un proxy delante: así req.ip es la IP real del cliente.
app.set('trust proxy', env.trustProxy);

const corsOrigin = env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((s) => s.trim());
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '5mb' }));

// --- Healthcheck ---------------------------------------------------------
app.get('/health', async (_req: Request, res: Response) => {
  const db = dbEnabled() ? await dbHealthy() : false;
  res.json({
    ok: true,
    service: 'crm-multimesa-server',
    time: new Date().toISOString(),
    db: { configured: dbEnabled(), up: db },
    apify: { configured: !!env.apifyToken.trim() },
    ai: { configured: hasAI(), model: hasAI() ? env.openaiModel : null }
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.redirect(307, '/health');
});

// --- API -----------------------------------------------------------------
// Públicas: login y estado de la IA. Todo lo demás exige sesión.
app.use('/api', publicAuth);
app.use('/api', publicAi);
app.use('/api', requireAuth);
app.use('/api', privateAuth);
app.use('/api', searchRoutes);
app.use('/api', leadRoutes);
app.use('/api', configRoutes);
app.use('/api', aiRoutes);

// --- Frontend estático (index.html + assets) -----------------------------
const staticDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, '..', '..');
app.use(express.static(staticDir, { extensions: ['html'] }));

app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api/') || req.path === '/health') {
    res.status(404).json({ error: 'No encontrado' });
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'), (err) => {
    if (err) res.status(404).send('index.html no encontrado');
  });
});

// --- Manejo de errores ---------------------------------------------------
app.use((err: Error & { type?: string; status?: number; code?: string }, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Errores de express.json(): JSON mal formado o demasiado grande.
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON mal formado' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Petición demasiado grande' });
    return;
  }
  const pg = pgErrorToHttp(err);
  if (pg) {
    console.warn(`[db] ${req.method} ${req.path}: ${err.code} ${err.message}`);
    res.status(pg.status).json({ error: pg.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: env.isProd ? 'Error interno' : err.message });
});

// Red de seguridad: un fallo fuera de una ruta se registra, pero no tumba el
// servidor ni las búsquedas que estén en curso.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// --- Arranque ------------------------------------------------------------
async function start(): Promise<void> {
  if (dbEnabled()) {
    try {
      await migrate();
      await bootstrapAdmin();
    } catch (e) {
      // Sin esquema la API no puede funcionar: mejor fallar en el arranque
      // (Railway lo reintenta y lo verás en los logs) que servir errores.
      console.error('[db] migración fallida:', (e as Error).message);
      process.exit(1);
    }
  } else {
    console.warn('[db] DATABASE_URL no configurada: los endpoints de datos devolverán 503.');
  }

  const server = app.listen(env.port, () => {
    console.log(`[crm-server] escuchando en :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async () => {
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  void start();
}

export default app;
