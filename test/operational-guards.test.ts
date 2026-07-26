import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/jer/config.js';
import { cliExitCode } from '../src/jer/domain.js';
import { parseOperationalOverrides } from '../src/jer/cli.js';

const baseEnv = {
  JER_RESULTS_BASE_URL: 'https://jer.example.test/',
  JER_RESULTS_PATH: 'resultados/',
  JER_REQUEST_TIMEOUT_MS: '30000',
  JER_USER_AGENT: 'Jer operational guards test'
};

describe('JER operational configuration', () => {
  it('applies every conservative default and preserves the existing URL, path, user-agent, and database configuration', () => {
    expect(loadConfig(baseEnv)).toMatchObject({
      baseUrl: 'https://jer.example.test',
      resultsUrl: 'https://jer.example.test/resultados/',
      timeoutMs: 30000,
      userAgent: 'Jer operational guards test',
      databasePath: './data/jer-results.db',
      enabled: true,
      batchSize: 5,
      maxBatchesPerRun: 5,
      maxResultsPerRun: 25,
      delayMs: 10000,
      batchPauseMs: 180000,
      concurrency: 1,
      maxRetries: 5,
      blockCooldownMs: 21600000,
      rateLimitCooldownMs: 3600000,
      leaseDurationMs: 60000,
      leaseRenewIntervalMs: 20000
    });
  });

  it.each([
    ['JER_BATCH_SIZE', '0'], ['JER_BATCH_SIZE', '51'],
    ['JER_MAX_BATCHES_PER_RUN', '101'], ['JER_MAX_RESULTS_PER_RUN', '-1'],
    ['JER_REQUEST_DELAY_MS', '4999'], ['JER_BATCH_PAUSE_MS', '3600001'],
    ['JER_CONCURRENCY', '2'], ['JER_MAX_RETRIES', '11'],
    ['JER_BLOCK_COOLDOWN_MS', '3599999'], ['JER_RATE_LIMIT_COOLDOWN_MS', '59999'],
    ['JER_LEASE_DURATION_MS', '29999'], ['JER_LEASE_RENEW_INTERVAL_MS', '300000'],
    ['JER_LEASE_RENEW_INTERVAL_MS', '60000']
  ])('rejects invalid operational bound %s=%s before dependencies start', (key, value) => {
    const startLeaseOrNetwork = vi.fn();

    expect(() => {
      loadConfig({ ...baseEnv, [key]: value });
      startLeaseOrNetwork();
    }).toThrow();
    expect(startLeaseOrNetwork).not.toHaveBeenCalled();
  });

  it('rejects unknown JER values and malformed numeric values before dependencies start', () => {
    const startLeaseOrNetwork = vi.fn();

    expect(() => {
      loadConfig({ ...baseEnv, JER_UNKNOWN_GUARD: 'unsafe' });
      startLeaseOrNetwork();
    }).toThrow();
    expect(startLeaseOrNetwork).not.toHaveBeenCalled();
    expect(() => loadConfig({ ...baseEnv, JER_BATCH_SIZE: 'five' })).toThrow();
  });

  it('validates typed CLI overrides through the same bounds and applies them over environment values', () => {
    const overrides = parseOperationalOverrides({
      'batch-size': '50',
      'max-batches-per-run': '100',
      'max-results-per-run': '1000',
      'request-delay-ms': '60000',
      'batch-pause-ms': '3600000',
      concurrency: '1',
      'max-retries': '0',
      'block-cooldown-ms': '86400000',
      'rate-limit-cooldown-ms': '21600000',
      'lease-duration-ms': '900000',
      'lease-renew-interval-ms': '300000'
    });

    expect(loadConfig(baseEnv, overrides)).toMatchObject({
      batchSize: 50,
      maxBatchesPerRun: 100,
      maxResultsPerRun: 1000,
      delayMs: 60000,
      batchPauseMs: 3600000,
      concurrency: 1,
      maxRetries: 0,
      blockCooldownMs: 86400000,
      rateLimitCooldownMs: 21600000,
      leaseDurationMs: 900000,
      leaseRenewIntervalMs: 300000
    });
    expect(() => parseOperationalOverrides({ concurrency: '2' })).toThrow();
    expect(() => parseOperationalOverrides({ 'unknown-guard': 'unsafe' })).toThrow();
  });
});

describe('operational outcome contracts', () => {
  it.each([
    ['SUCCESS', 0], ['FAILED', 1], ['PARTIAL', 2], ['BLOCKED', 3], ['RATE_LIMITED', 4], ['CANCELLED', 130]
  ] as const)('maps %s to exit %i', (status, code) => {
    expect(cliExitCode(status)).toBe(code);
  });
});

describe('deployed migration reconciliation contracts', () => {
  const operationalMigration = resolve(process.cwd(), 'supabase/migrations/202607240003_jer_operational_guards.sql');
  const drawResultsMigration = resolve(process.cwd(), 'supabase/migrations/202607230001_draw_results.sql');

  it('reconciles only the equivalent JER source-state table and canonical source-code constraint', () => {
    const migration = readFileSync(operationalMigration, 'utf8');
    const table = 'create table if not exists public.scraping_source_states';
    const drop = 'drop constraint if exists draw_ingestion_runs_source_code_check';
    const add = "add constraint draw_ingestion_runs_source_code_check check (source_code = 'jer') not valid";
    const validate = 'validate constraint draw_ingestion_runs_source_code_check';

    expect(migration.toLowerCase()).toContain(table);
    expect(migration).toContain("check (source_code = 'JER' and source_host = 'jer.com.co')");
    expect(migration).toContain('owner_token uuid');
    expect(migration).toContain('lease_expires_at timestamptz');
    expect(migration.toLowerCase().indexOf(drop)).toBeGreaterThan(-1);
    expect(migration.toLowerCase().indexOf(add)).toBeGreaterThan(migration.toLowerCase().indexOf(drop));
    expect(migration.toLowerCase().indexOf(validate)).toBeGreaterThan(migration.toLowerCase().indexOf(add));
    expect(migration).toContain('function public.jer_acquire_and_gate(');
    expect(migration).toContain('function public.jer_save_progress(');
  });

  it('pins the draw-update trigger function search path without changing its timestamp body or triggers', () => {
    const migration = readFileSync(drawResultsMigration, 'utf8');

    expect(migration).toMatch(/create or replace function public\.set_draw_updated_at\(\)\s+returns trigger language plpgsql\s+set search_path = pg_catalog, public as \$\$/i);
    expect(migration).toMatch(/begin\s+new\.updated_at = now\(\);\s+return new;\s+end;/i);
    expect(migration).toMatch(/create trigger draw_games_updated_at before update on public\.draw_games/i);
    expect(migration).toMatch(/create trigger draw_results_updated_at before update on public\.draw_results/i);
  });
});
