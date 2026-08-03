import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JerBlockedError, JerHtmlStructureChangedError, JerRateLimitError, type DiscoveredGame, type NormalizedDrawResult } from '../src/jer/domain.js';
import { ScrapedoRuntime, ProviderStateCommitter } from '../src/jer/scrapedo-runtime.js';
import type { ProviderStateV1, SessionAttempt, SessionAttemptOutcome } from '../src/jer/session-policy.js';
import { JerSource } from '../src/jer/use-cases.js';

const state = (overrides: Partial<ProviderStateV1> = {}): ProviderStateV1 => ({ schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 42, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false, ...overrides });
const game: DiscoveredGame = { code: 'A', name: 'A', type: 'CHANCE', detailUrl: 'https://jer.example/a', active: true };
const draw: NormalizedDrawResult = { gameCode: 'A', gameName: 'A', gameType: 'CHANCE', drawDate: '2026-07-01', winningNumber: '1234', sourceUrl: game.detailUrl, sourceHash: 'hash', fetchedAt: new Date('2026-07-01T00:00:00Z'), verified: true };
const progress = { attempted: 1, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' };

function sourceWithRuntime(options: {
  initial?: ProviderStateV1;
  policy?: { execute(previous: ProviderStateV1 | undefined, request: (attempt: SessionAttempt) => Promise<SessionAttemptOutcome>): Promise<{ state: ProviderStateV1; attempts: SessionAttempt[]; outcome: string }>; };
  response?: { status: number; headers?: Record<string, string>; body: string };
  logger?: (event: Record<string, unknown>) => void;
}) {
  const attempts: SessionAttempt[] = [];
  const requestRaw = vi.fn(async () => ({ status: options.response?.status ?? 200, headers: new Headers(options.response?.headers), body: options.response?.body ?? 'ok' }));
  const save = vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState }));
  const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'next-token' });
  const policy = options.policy ?? { execute: async (previous: ProviderStateV1 | undefined, request: (attempt: SessionAttempt) => Promise<SessionAttemptOutcome>) => {
    const current = previous!;
    const attempt: SessionAttempt = current.tier === 'SUPER' ? { sessionId: current.sessionId!, tier: 'SUPER', transportOptions: { super: true } } : { sessionId: current.sessionId!, tier: 'STANDARD', transportOptions: { super: false } };
    return { state: current, attempts: [attempt], outcome: (await request(attempt)).kind };
  } };
  const runtime = new ScrapedoRuntime({ policy, committer, retryDelayMs: 1, sleep: vi.fn(async () => undefined) });
  if (options.initial) runtime.bind({ runId: 'run-1', ownerToken: 'owner-1', committed: { version: 1, requestToken: 'resume-token', providerState: options.initial } });
  const main = { parseGames: vi.fn(() => [game]), parseLatest: vi.fn(() => ({ results: [draw], rejected: [] })) };
  const history = { getDates: vi.fn(() => ['2026-07-01']), parse: vi.fn(() => draw) };
  const source = new JerSource({ get: vi.fn(), postForm: vi.fn() } as never, main as never, history as never, 'https://jer.example/results', { runtime, progress: () => progress, transportFactory: (attempt: SessionAttempt) => { attempts.push(attempt); return { requestRaw }; }, logger: options.logger } as never);
  return { source, runtime, requestRaw, save, attempts, main, history };
}

describe('JerSource Scrape.do request executor', () => {
  it('keeps the direct source on its legacy transport without runtime or provider state', async () => {
    const http = { get: vi.fn(async () => 'main'), postForm: vi.fn(async () => 'history') };
    const main = { parseGames: vi.fn(() => [game]), parseLatest: vi.fn(() => ({ results: [draw], rejected: [] })) };
    const history = { getDates: vi.fn(() => ['2026-07-01']), parse: vi.fn(() => draw) };
    const source = new JerSource(http, main as never, history as never, 'https://jer.example/results');

    await expect(source.discover()).resolves.toEqual([game]);
    await expect(source.historical(game, '2026-07-01')).resolves.toEqual(draw);
    expect(http.get).toHaveBeenCalledWith('https://jer.example/results', undefined);
    expect(http.postForm).toHaveBeenCalledWith(game.detailUrl, { fecha: '2026-07-01' }, undefined);
  });

  it('fails an unbound source before creating a provider attempt', async () => {
    const f = sourceWithRuntime({});
    await expect(f.source.discover()).rejects.toMatchObject({ code: 'SCRAPEDO_PROVIDER_ERROR' });
    expect(f.requestRaw).not.toHaveBeenCalled();
  });

  it('passes restored STANDARD and SUPER session state into every GET and POST provider request', async () => {
    const standard = sourceWithRuntime({ initial: state() });
    await standard.source.discover(); await standard.source.mainSnapshot(); await standard.source.dates(game.detailUrl); await standard.source.historical(game, '2026-07-01');
    expect(standard.requestRaw).toHaveBeenCalledTimes(4);
    expect(standard.attempts.map(attempt => [attempt.sessionId, attempt.tier, attempt.transportOptions.super])).toEqual([[42, 'STANDARD', false], [42, 'STANDARD', false], [42, 'STANDARD', false], [42, 'STANDARD', false]]);
    const rawCalls = standard.requestRaw.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(rawCalls.map(([url, init]) => [url, init.method, init.body, init.headers])).toEqual([
      ['https://jer.example/results', 'GET', undefined, undefined], ['https://jer.example/results', 'GET', undefined, undefined], [game.detailUrl, 'GET', undefined, undefined], [game.detailUrl, 'POST', 'fecha=2026-07-01', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ]);

    const superSource = sourceWithRuntime({ initial: state({ tier: 'SUPER', sessionId: 99 }) });
    await superSource.source.discover();
    expect(superSource.attempts).toContainEqual({ sessionId: 99, tier: 'SUPER', transportOptions: { super: true } });
  });

  it('rotates the next request after a challenge and persists only the rotated candidate', async () => {
    const initial = state();
    const policy = { execute: async (_previous: ProviderStateV1 | undefined, request: (attempt: SessionAttempt) => Promise<SessionAttemptOutcome>) => {
      const first: SessionAttempt = { sessionId: 42, tier: 'STANDARD', transportOptions: { super: false } };
      await request(first);
      const rotated: SessionAttempt = { sessionId: 77, tier: 'STANDARD', transportOptions: { super: false } };
      return { state: state({ sessionId: 77 }), attempts: [first, rotated], outcome: (await request(rotated)).kind };
    } };
    const f = sourceWithRuntime({ initial, policy, response: { status: 200, body: 'ok' } });
    f.requestRaw.mockResolvedValueOnce({ status: 200, headers: new Headers(), body: 'Verificando su solicitud' }).mockResolvedValueOnce({ status: 200, headers: new Headers(), body: 'ok' });
    await f.source.discover();
    expect(f.attempts.map(attempt => attempt.sessionId)).toEqual([42, 77]);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: expect.objectContaining({ sessionId: 77 }) }));
  });

  it.each([
    ['target 403', 403, { 'Scrape.do-Initial-Status-Code': '403', 'Scrape.do-Target-Url': game.detailUrl }, JerBlockedError],
    ['target 429', 429, { 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': game.detailUrl }, JerRateLimitError],
  ])('propagates %s before parser state mutation', async (_name, status, headers, ErrorType) => {
    const f = sourceWithRuntime({ initial: state(), response: { status, headers, body: '' } });
    await expect(f.source.dates(game.detailUrl)).rejects.toBeInstanceOf(ErrorType);
    expect(f.history.getDates).not.toHaveBeenCalled();
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it('keeps target-429 state active and exposes a threshold block as non-retryable to the use case', async () => {
    const active = state({ standardBlockedSessionCount: 1 });
    const limited = sourceWithRuntime({ initial: active, response: { status: 429, headers: { 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': game.detailUrl }, body: '' } });
    await expect(limited.source.dates(game.detailUrl)).rejects.toBeInstanceOf(JerRateLimitError);
    expect(limited.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: active }));
    expect(limited.source.canRetryScrapedoBlockedRequest()).toBe(false);

    const pending = state({ sessionStatus: 'INVALID', standardBlockedSessionCount: 2, pendingSuper: true });
    const policy = { execute: async (_previous: ProviderStateV1 | undefined, request: (attempt: SessionAttempt) => Promise<SessionAttemptOutcome>) => {
      await request({ sessionId: 42, tier: 'STANDARD', transportOptions: { super: false } });
      return { state: pending, attempts: [], outcome: 'blocked' };
    } };
    const blocked = sourceWithRuntime({ initial: state(), policy, response: { status: 403, headers: { 'Scrape.do-Initial-Status-Code': '403', 'Scrape.do-Target-Url': game.detailUrl }, body: '' } });
    await expect(blocked.source.dates(game.detailUrl)).rejects.toBeInstanceOf(JerBlockedError);
    expect(blocked.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: pending }));
    expect(blocked.source.canRetryScrapedoBlockedRequest()).toBe(false);
  });

  it('retries an untrusted provider 429 once without rotating or committing state', async () => {
    const f = sourceWithRuntime({ initial: state(), response: { status: 429, body: '' } });
    await expect(f.source.discover()).rejects.toMatchObject({ code: 'SCRAPEDO_PROVIDER_ERROR' });
    expect(f.requestRaw).toHaveBeenCalledTimes(2);
    expect(f.attempts.map(attempt => attempt.sessionId)).toEqual([42, 42]);
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([
    ['credits/auth', 401, ''],
    ['authentication throttle', 200, 'Your request has been temporarily throttled by the authentication server.'],
    ['upstream', 502, ''],
    ['provider 510', 510, ''],
    ['provider 400', 400, ''],
    ['unknown provider status', 599, ''],
  ])('keeps provider %s failures nonrotating through the source/runtime path', async (_name, status, body) => {
    const initial = state({ standardBlockedSessionCount: 1 });
    const f = sourceWithRuntime({ initial, response: { status, body } });

    await expect(f.source.dates(game.detailUrl)).rejects.toMatchObject({ code: 'SCRAPEDO_PROVIDER_ERROR' });
    expect(f.requestRaw).toHaveBeenCalledTimes(1);
    expect(f.attempts).toEqual([{ sessionId: 42, tier: 'STANDARD', transportOptions: { super: false } }]);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: initial }));
  });

  it('returns null only for bounded historical no-results and keeps structural parser failures nonrotating', async () => {
    const none = sourceWithRuntime({ initial: state(), response: { status: 200, body: '<form><select name="fecha"><option value="2026-07-01"></option></select><div class="resultado-historico">No se encontraron resultados</div></form>' } });
    await expect(none.source.historical(game, '2026-07-01')).resolves.toBeNull();
    expect(none.history.parse).not.toHaveBeenCalled();

    const broken = sourceWithRuntime({ initial: state(), response: { status: 200, body: 'broken' } });
    broken.main.parseGames.mockImplementation(() => { throw new JerHtmlStructureChangedError('changed'); });
    await expect(broken.source.discover()).rejects.toThrow('changed');
    expect(broken.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: expect.objectContaining({ sessionId: 42 }) }));
  });

  it('logs bounded redacted diagnostics when a Scrape.do 2xx date page is unknown HTML', async () => {
    const logger = vi.fn();
    const title = `Unexpected provider response ${'x'.repeat(140)}`;
    const body = `<html><head><title>${title}</title></head><body>private-body-value</body></html>`;
    const f = sourceWithRuntime({ initial: state(), response: { status: 200, body }, logger });
    f.history.getDates.mockImplementation(() => { throw new JerHtmlStructureChangedError('Date selector select[name="fecha"] was not found'); });

    await expect(f.source.dates(game.detailUrl)).rejects.toMatchObject({ code: 'JER_HTML_STRUCTURE_CHANGED' });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith({
      provider: 'SCRAPEDO',
      classification: 'unknown_html',
      operation: 'dates',
      method: 'GET',
      targetUrl: game.detailUrl,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      bodyCharacters: [...body].length,
      title: title.slice(0, 120),
      bodySha256: createHash('sha256').update(body).digest('hex').slice(0, 12),
      expectedMarkers: { hasDateSelector: false },
    });
    const serialized = JSON.stringify(logger.mock.calls);
    expect(serialized).not.toContain('private-body-value');
    expect(serialized).not.toContain('api.scrape.do');
    expect(serialized).not.toContain('token');
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ providerState: expect.objectContaining({ sessionId: 42 }) }));
  });
});
