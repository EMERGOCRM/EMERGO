import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { env } from './env';
import { migrate, dbEnabled, dbHealthy, closePool } from './db';
import searchRoutes from './routes/search';
import leadRoutes from './routes/leads';
import configRoutes from './routes/config';

const app = express();

app.disable('x-powered-by');

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
    apify: { configured: !!env.apifyToken.trim() }
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.redirect(307, '/health');
});

// --- API -----------------------------------------------------------------
app.use('/api', searchRoutes);
app.use('/api', leadRoutes);
app.use('/api', configRoutes);

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
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err.message);
  res.status(500).json({ error: env.isProd ? 'Error interno' : err.message });
});

// --- Arranque ------------------------------------------------------------
async function start(): Promise<void> {
  if (dbEnabled()) {
    try {
      await migrate();
    } catch (e) {
      console.error('[db] migración fallida:', (e as Error).message);
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
