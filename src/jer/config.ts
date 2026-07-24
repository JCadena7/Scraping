import { z } from 'zod';

const env = z.object({
  JER_RESULTS_BASE_URL: z.string().url().default('https://jer.com.co'),
  JER_RESULTS_PATH: z.string().default('/resultados/'),
  JER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  JER_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(5000),
  JER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  JER_USER_AGENT: z.string().min(1).default('ResultadosColombia/1.0 contacto@example.com'),
  JER_SCRAPER_ENABLED: z.enum(['true', 'false']).default('true'),
  JER_DATABASE_PATH: z.string().default('./data/jer-results.db')
});

export interface JerConfig { baseUrl: string; resultsUrl: string; timeoutMs: number; delayMs: number; maxRetries: number; userAgent: string; enabled: boolean; databasePath: string; }

export function loadConfig(values: NodeJS.ProcessEnv = process.env): JerConfig {
  const parsed = env.parse(values);
  return { baseUrl: parsed.JER_RESULTS_BASE_URL.replace(/\/$/, ''), resultsUrl: `${parsed.JER_RESULTS_BASE_URL.replace(/\/$/, '')}${parsed.JER_RESULTS_PATH.startsWith('/') ? parsed.JER_RESULTS_PATH : `/${parsed.JER_RESULTS_PATH}`}`, timeoutMs: parsed.JER_REQUEST_TIMEOUT_MS, delayMs: parsed.JER_REQUEST_DELAY_MS, maxRetries: parsed.JER_MAX_RETRIES, userAgent: parsed.JER_USER_AGENT, enabled: parsed.JER_SCRAPER_ENABLED === 'true', databasePath: parsed.JER_DATABASE_PATH };
}
