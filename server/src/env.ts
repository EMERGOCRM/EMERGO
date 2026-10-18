import dotenv from 'dotenv';

dotenv.config();

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v);
}

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  port: int('PORT', 3000),
  nodeEnv: str('NODE_ENV', 'development'),

  // Cadena de conexión a PostgreSQL. En Railway se inyecta automáticamente al
  // añadir el plugin de Postgres. En local la aporta docker-compose.
  databaseUrl: str('DATABASE_URL', ''),

  // Token de Apify. NUNCA se expone al navegador: queda solo aquí.
  apifyToken: str('APIFY_TOKEN', ''),
  apifyActor: str('APIFY_DEFAULT_ACTOR', 'compass/crawler-google-places'),
  apifyApi: str('APIFY_API', 'https://api.apify.com/v2'),
  apifyTimeoutMs: int('APIFY_TIMEOUT_MS', 185000),

  // IA compatible con OpenAI (OpenAI, Groq, Together, Ollama…). La clave vive
  // solo en el servidor; el navegador nunca la recibe.
  openaiApiKey: str('OPENAI_API_KEY', ''),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
  aiTimeoutMs: int('AI_TIMEOUT_MS', 60000),

  // Orígenes permitidos para CORS (separados por coma). "*" permite todos.
  corsOrigin: str('CORS_ORIGIN', '*'),

  isProd: str('NODE_ENV', 'development') === 'production'
};

export function hasApifyToken(): boolean {
  return !!env.apifyToken.trim();
}

export function hasAI(): boolean {
  return !!env.openaiApiKey.trim();
}
