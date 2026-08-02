import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/jer/config.js';

const secret = 'scrapedo-secret-token';
const scrapedo = (values: NodeJS.ProcessEnv = {}) => ({
  JER_PROVIDER: 'SCRAPEDO',
  JER_SCRAPEDO_TOKEN: secret,
  ...values,
});

describe('JER provider configuration', () => {
  it('uses direct transport by default without requiring a provider token', () => {
    expect(loadConfig({})).toMatchObject({ provider: { kind: 'DIRECT' } });
  });

  it.each([
    { JER_PROVIDER: 'SCRAPEDO' },
    { JER_PROVIDER: 'SCRAPEDO', JER_SCRAPEDO_TOKEN: '' },
    { JER_PROVIDER: 'SCRAPEDO', JER_SCRAPEDO_TOKEN: secret, JER_SCRAPEDO_ENDPOINT: 'not-a-url' },
    { JER_PROVIDER: 'OTHER', JER_SCRAPEDO_TOKEN: secret },
  ])('fails explicit Scrape.do configuration before transport without leaking its token: %#', values => {
    expect(() => loadConfig(values)).toThrow();
    try { loadConfig(values); }
    catch (error) { expect(String(error)).not.toContain(secret); }
  });

  it('validates provider flags, session threshold, and the one-retry hard limit', () => {
    expect(loadConfig(scrapedo({ JER_SCRAPEDO_SUPER_ENABLED: 'true', JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS: '3', JER_SCRAPEDO_MAX_RETRIES: '1' })).provider).toMatchObject({ kind: 'SCRAPEDO', superEnabled: true, maxStandardBlockedSessions: 3, maxRetries: 1 });
    for (const values of [
      { JER_SCRAPEDO_SUPER_ENABLED: 'yes' },
      { JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS: '0' },
      { JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS: '1001' },
      { JER_SCRAPEDO_MAX_RETRIES: '0' },
      { JER_SCRAPEDO_MAX_RETRIES: '2' },
    ]) expect(() => loadConfig(scrapedo(values))).toThrow();
  });

  it('keeps Super disabled by default and does not make it active until policy requests it', () => {
    expect(loadConfig(scrapedo()).provider).toMatchObject({ kind: 'SCRAPEDO', superEnabled: false, maxRetries: 1 });
  });

  it('documents the actual Scrape.do configuration names, defaults, and backfill-only boundary', () => {
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('JER_PROVIDER=SCRAPEDO');
    expect(readme).toContain('JER_SCRAPEDO_TOKEN=replace-with-your-scrapedo-token');
    expect(readme).toContain('JER_SCRAPEDO_ENDPOINT=https://api.scrape.do/');
    expect(readme).toContain('JER_SCRAPEDO_SUPER_ENABLED=false');
    expect(readme).toContain('JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS=2');
    expect(readme).toContain('JER_SCRAPEDO_MAX_RETRIES=1');
    expect(readme).toContain('available only for `backfill`');
  });

  it('documents direct preservation and the non-rotating provider failure boundary', () => {
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('**Direct is the default.**');
    expect(readme).toContain('`discover` and `latest` fail fast before a Supabase client');
    expect(readme).toContain('No rotation, cooldown, or Super.');
    expect(readme).toContain('The `Scrape.do-Request-Cost` response header is authoritative');
  });
});
