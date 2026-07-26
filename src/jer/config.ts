import { z } from 'zod';

const operationalConfigValues = z.object({
  batchSize: z.coerce.number().int().min(1).max(50).default(5),
  maxBatchesPerRun: z.coerce.number().int().min(1).max(100).default(5),
  maxResultsPerRun: z.coerce.number().int().min(1).max(1000).default(25),
  delayMs: z.coerce.number().int().min(5000).max(60000).default(10000),
  batchPauseMs: z.coerce.number().int().min(30000).max(3600000).default(180000),
  concurrency: z.preprocess(value => value === undefined ? value : Number(value), z.literal(1).default(1)),
  maxRetries: z.coerce.number().int().min(0).max(10).default(5),
  blockCooldownMs: z.coerce.number().int().min(3600000).max(86400000).default(21600000),
  rateLimitCooldownMs: z.coerce.number().int().min(60000).max(21600000).default(3600000),
  leaseDurationMs: z.coerce.number().int().min(30000).max(900000).default(60000),
  leaseRenewIntervalMs: z.coerce.number().int().min(5000).max(300000).default(20000)
});

const operationalConfigSchema = operationalConfigValues.strict().superRefine((value, context) => {
  if (value.leaseRenewIntervalMs >= value.leaseDurationMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['leaseRenewIntervalMs'], message: 'leaseRenewIntervalMs must be less than leaseDurationMs' });
});

const env = z.object({
  JER_RESULTS_BASE_URL: z.string().url().default('https://jer.com.co'),
  JER_RESULTS_PATH: z.string().default('/resultados/'),
  JER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  JER_USER_AGENT: z.string().min(1).default('ResultadosColombia/1.0 contacto@example.com'),
  JER_SCRAPER_ENABLED: z.enum(['true', 'false']).default('true'),
  JER_DATABASE_PATH: z.string().default('./data/jer-results.db'),
  JER_BATCH_SIZE: z.string().optional(),
  JER_MAX_BATCHES_PER_RUN: z.string().optional(),
  JER_MAX_RESULTS_PER_RUN: z.string().optional(),
  JER_REQUEST_DELAY_MS: z.string().optional(),
  JER_BATCH_PAUSE_MS: z.string().optional(),
  JER_CONCURRENCY: z.string().optional(),
  JER_MAX_RETRIES: z.string().optional(),
  JER_BLOCK_COOLDOWN_MS: z.string().optional(),
  JER_RATE_LIMIT_COOLDOWN_MS: z.string().optional(),
  JER_LEASE_DURATION_MS: z.string().optional(),
  JER_LEASE_RENEW_INTERVAL_MS: z.string().optional()
}).strict();

const operationalOverridesSchema = operationalConfigValues.partial().strict();

export type JerOperationalOverrides = z.input<typeof operationalOverridesSchema>;
export interface JerConfig extends z.output<typeof operationalConfigSchema> {
  baseUrl: string;
  resultsUrl: string;
  timeoutMs: number;
  userAgent: string;
  enabled: boolean;
  databasePath: string;
}

export function parseOperationalOverrides(values: unknown): JerOperationalOverrides {
  return operationalOverridesSchema.parse(values);
}

export function loadConfig(values: NodeJS.ProcessEnv = process.env, overrides: JerOperationalOverrides = {}): JerConfig {
  const parsed = env.parse(selectJerValues(values));
  const operational = operationalConfigSchema.parse({
    batchSize: parsed.JER_BATCH_SIZE,
    maxBatchesPerRun: parsed.JER_MAX_BATCHES_PER_RUN,
    maxResultsPerRun: parsed.JER_MAX_RESULTS_PER_RUN,
    delayMs: parsed.JER_REQUEST_DELAY_MS,
    batchPauseMs: parsed.JER_BATCH_PAUSE_MS,
    concurrency: parsed.JER_CONCURRENCY,
    maxRetries: parsed.JER_MAX_RETRIES,
    blockCooldownMs: parsed.JER_BLOCK_COOLDOWN_MS,
    rateLimitCooldownMs: parsed.JER_RATE_LIMIT_COOLDOWN_MS,
    leaseDurationMs: parsed.JER_LEASE_DURATION_MS,
    leaseRenewIntervalMs: parsed.JER_LEASE_RENEW_INTERVAL_MS,
    ...parseOperationalOverrides(overrides)
  });
  const baseUrl = parsed.JER_RESULTS_BASE_URL.replace(/\/$/, '');
  return { baseUrl, resultsUrl: `${baseUrl}${parsed.JER_RESULTS_PATH.startsWith('/') ? parsed.JER_RESULTS_PATH : `/${parsed.JER_RESULTS_PATH}`}`, timeoutMs: parsed.JER_REQUEST_TIMEOUT_MS, userAgent: parsed.JER_USER_AGENT, enabled: parsed.JER_SCRAPER_ENABLED === 'true', databasePath: parsed.JER_DATABASE_PATH, ...operational };
}

function selectJerValues(values: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('JER_')));
}
