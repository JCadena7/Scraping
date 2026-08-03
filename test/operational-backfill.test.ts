import { describe, expect, it, vi } from 'vitest';
import { JerBlockedError, JerHtmlStructureChangedError, JerRateLimitError, type DiscoveredGame, type NormalizedDrawResult } from '../src/jer/domain.js';
import { BackfillJerResultsUseCase, type BackfillOperationalDependencies } from '../src/jer/use-cases.js';
import { ScrapedoSessionPolicy, type ProviderStateV1, type SessionAttempt, type SessionIdGenerator } from '../src/jer/session-policy.js';
import { ProviderStateCommitter, ScrapedoProviderError, ScrapedoRuntime, type ProgressWriteWithoutVersionTokenProviderState, type ProviderStateWriter } from '../src/jer/scrapedo-runtime.js';
import { JerSource } from '../src/jer/use-cases.js';

const games: DiscoveredGame[] = [
  { code: 'A', name: 'A', type: 'CHANCE', detailUrl: 'https://jer.example/a', active: true },
  { code: 'B', name: 'B', type: 'CHANCE', detailUrl: 'https://jer.example/b', active: true },
];

function result(game: DiscoveredGame, date: string): NormalizedDrawResult {
  return { gameCode: game.code, gameName: game.name, gameType: game.type, drawDate: date, winningNumber: '1234', sourceUrl: game.detailUrl, sourceHash: `${game.code}/${date}`, fetchedAt: new Date('2026-07-25T00:00:00.000Z'), verified: true };
}

function fixture(overrides: Partial<BackfillOperationalDependencies> = {}) {
  const calls: string[] = [];
  const heartbeatSleep = deferred<void>();
  let token = 0;
  const source = {
    discover: vi.fn(async () => { calls.push('GET:catalog'); return games; }),
    dates: vi.fn(async (url: string) => { calls.push(`GET:${url}`); return url.endsWith('/a') ? ['2026-07-01', '2026-07-02'] : ['2026-07-03']; }),
    historical: vi.fn(async (game: DiscoveredGame, date: string): Promise<NormalizedDrawResult | null> => { calls.push(`POST:${game.code}/${date}`); return result(game, date); }),
  };
  const repository = {
    startRun: vi.fn(async () => 'run-1'), startOrResumeScrapedoBackfill: vi.fn(async (): Promise<{ runId: string; providerState: ProviderStateV1 | undefined; version: number; requestToken: string }> => ({ runId: 'scrapedo-run', providerState: undefined, version: 0, requestToken: 'resume-token' })), upsertGames: vi.fn(async () => undefined), existingDates: vi.fn(async (_gameCode: string) => [] as string[]),
    upsertResult: vi.fn(async () => 'inserted' as const), finishRun: vi.fn(async () => undefined),
  };
  const dependencies: BackfillOperationalDependencies = {
    ownerToken: 'owner-1', leaseDurationMs: 60_000, renewIntervalMs: 20_000, batchSize: 2, maxBatches: 2, maxResults: 3,
    batchPauseMs: 50, blockCooldownMs: 21_600_000, rateLimitCooldownMs: 3_600_000,
    acquireAndGate: vi.fn(async () => ({ acquired: true, state: 'ACTIVE' as const })),
    nextRequestToken: vi.fn(() => `token-${++token}`),
    ensureActive: vi.fn(async () => { calls.push('GATE'); return { state: 'ACTIVE' as const }; }), renew: vi.fn(async () => { calls.push('RENEW'); return true; }), release: vi.fn(async () => { calls.push('RELEASE'); }),
    saveProgress: vi.fn(async (_runId, progress) => { calls.push(`SAVE:${progress.version}:${progress.attempted}:${progress.requestToken}`); }), transition403: vi.fn(async () => undefined), transition429: vi.fn(async () => undefined),
    sleep: vi.fn(async ms => { if (ms === 20_000) await heartbeatSleep.promise; }),
    ...overrides,
  };
  return { calls, source, repository, dependencies, heartbeatSleep };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(currentResolve => { resolve = currentResolve; });
  return { promise, resolve };
}

describe('guarded operational backfill', () => {
  it('binds the Scrape.do runtime after the lease and start/resume receipt before the first request', async () => {
    const f = fixture();
    const order: string[] = [];
    f.dependencies.acquireAndGate = vi.fn(async () => { order.push('lease'); return { acquired: true, state: 'ACTIVE' as const }; });
    f.dependencies.startProviderRun = vi.fn(async progress => {
      order.push(`bind:${progress().attempted}:${progress().status}`);
      return { runId: 'scrapedo-run', saveProgress: vi.fn(async () => { order.push('provider-save'); }) };
    });
    f.source.discover.mockImplementation(async () => { order.push('request'); return games; });

    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(order.indexOf('lease')).toBeLessThan(order.findIndex(entry => entry.startsWith('bind:')));
    expect(order.findIndex(entry => entry.startsWith('bind:'))).toBeLessThan(order.indexOf('request'));
  });

  it('uses the provider committer RPC for progress-only saves without pre-incrementing caller-owned versions', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    const saves: Array<{ attempted: number; skipped: number; status: string; nextPendingDate?: string }> = [];
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: vi.fn(async progress => { saves.push(progress); }) }));

    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(f.dependencies.saveProgress).not.toHaveBeenCalled();
    expect(saves).toContainEqual(expect.objectContaining({ attempted: 1, status: 'PAUSED' }));
    expect(saves.every(save => !('version' in save) && !('requestToken' in save) && !('providerState' in save))).toBe(true);
  });

  it('keeps direct operational runs on the legacy start/save path without provider RPCs', async () => {
    const f = fixture();
    await expect(new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational()).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(f.repository.startRun).toHaveBeenCalledWith('BACKFILL', 'owner-1');
    expect(f.repository.startOrResumeScrapedoBackfill).not.toHaveBeenCalled();
    expect(f.dependencies.saveProgress).toHaveBeenCalled();
  });


  it('records a valid no-results historical date as skipped without persisting a result', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    f.source.historical.mockResolvedValueOnce(null);

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'PAUSED', resultsFound: 0, resultsSkipped: 1 });
    expect(f.source.historical).toHaveBeenCalledTimes(1);
    expect(f.repository.upsertResult).not.toHaveBeenCalled();
    expect((f.dependencies.saveProgress as ReturnType<typeof vi.fn>).mock.calls.map(([, progress]) => progress)).toContainEqual(expect.objectContaining({ attempted: 1, skipped: 1 }));
  });

  it.each([
    ['discover', new JerBlockedError('blocked', 403, games[0].detailUrl), 'BLOCKED', 'transition403'],
    ['discover', new JerRateLimitError('limited', 429, games[0].detailUrl), 'PAUSED', 'transition429'],
    ['dates', new JerBlockedError('blocked', 403, games[0].detailUrl), 'BLOCKED', 'transition403'],
    ['dates', new JerRateLimitError('limited', 429, games[0].detailUrl), 'PAUSED', 'transition429'],
  ] as const)('transitions globally when %s receives terminal HTTP failure', async (phase, error, status, transition) => {
    const f = fixture();
    f.source[phase].mockRejectedValueOnce(error);
    await expect(new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational()).resolves.toMatchObject({ status, sourceState: status === 'BLOCKED' ? 'BLOCKED' : 'RATE_LIMITED' });
    expect(f.dependencies[transition]).toHaveBeenCalledWith('run-1', expect.objectContaining({ error: error.message }));
    expect(f.repository.finishRun).not.toHaveBeenCalled();
    expect(f.source.historical).not.toHaveBeenCalled();
  });

  it('shares a global result budget across games and persists an attempt immediately before each POST', async () => {
    const f = fixture({ maxResults: 2, batchSize: 5 });
    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01', 'POST:A/2026-07-02']);
    expect(f.dependencies.saveProgress).toHaveBeenCalledTimes(7);
    expect(f.dependencies.saveProgress).toHaveBeenNthCalledWith(3, 'run-1', expect.objectContaining({ version: 3, requestToken: 'token-3', attempted: 1, nextPendingDate: '2026-07-01' }));
    expect(f.dependencies.saveProgress).toHaveBeenNthCalledWith(5, 'run-1', expect.objectContaining({ version: 5, requestToken: 'token-5', attempted: 2, nextPendingDate: '2026-07-02' }));
    expect(summary.status).toBe('PAUSED');
  });

  it('only pauses between eligible batches, sleeps exactly once, and succeeds when the limit ends the final date', async () => {
    const paused = fixture({ batchSize: 2, maxBatches: 2, maxResults: 3, batchPauseMs: 123 });
    await expect(new BackfillJerResultsUseCase(paused.source as never, paused.repository as never, paused.dependencies).executeOperational()).resolves.toMatchObject({ status: 'SUCCESS', datesQueried: 3 });
    expect((paused.dependencies.sleep as ReturnType<typeof vi.fn>).mock.calls.filter(([ms]) => ms === 123)).toHaveLength(1);

    const finalBatch = fixture({ batchSize: 2, maxBatches: 1, maxResults: 2 });
    finalBatch.source.discover.mockResolvedValueOnce([games[0]]);
    finalBatch.source.dates.mockResolvedValueOnce(['2026-07-01', '2026-07-02']);
    await expect(new BackfillJerResultsUseCase(finalBatch.source as never, finalBatch.repository as never, finalBatch.dependencies).executeOperational()).resolves.toMatchObject({ status: 'SUCCESS' });
    expect((finalBatch.dependencies.sleep as ReturnType<typeof vi.fn>).mock.calls.filter(([ms]) => ms === finalBatch.dependencies.batchPauseMs)).toHaveLength(0);
  });

  it('acquires and gates before network, gates every GET and POST, renews, then releases exactly once', async () => {
    const f = fixture();
    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    expect((f.dependencies.acquireAndGate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(f.source.discover.mock.invocationCallOrder[0]);
    expect(f.dependencies.ensureActive).toHaveBeenCalledTimes(6);
    expect(f.dependencies.renew).toHaveBeenCalled();
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);

    const blocked = fixture({ acquireAndGate: vi.fn(async () => ({ acquired: false, state: 'BLOCKED' as const })) });
    await expect(new BackfillJerResultsUseCase(blocked.source as never, blocked.repository as never, blocked.dependencies).executeOperational()).resolves.toMatchObject({ status: 'BLOCKED' });
    expect(blocked.calls).toEqual([]);
  });

  it.each([
    [{ acquired: false, state: 'ACTIVE' as const }, 'FAILED'],
    [{ acquired: false, state: 'DISABLED' as const }, 'FAILED'],
    [{ acquired: false, state: 'BLOCKED' as const }, 'BLOCKED'],
    [{ acquired: false, state: 'RATE_LIMITED' as const }, 'PAUSED'],
  ])('does not start a run or network request when lease acquisition returns %o', async (lease, status) => {
    const f = fixture({ acquireAndGate: vi.fn(async () => lease) });
    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status, sourceState: lease.state });
    expect(f.repository.startRun).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.source.discover).not.toHaveBeenCalled();
    expect(f.source.dates).not.toHaveBeenCalled();
    expect(f.source.historical).not.toHaveBeenCalled();
  });

  it('blocks immediately on 403 and preserves the pending date while stopping later work', async () => {
    const f = fixture();
    f.source.historical.mockRejectedValueOnce(new JerBlockedError('forbidden', 403, games[0].detailUrl));
    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary.status).toBe('BLOCKED');
    expect(f.dependencies.transition403).toHaveBeenCalledWith('run-1', expect.objectContaining({ url: games[0].detailUrl, status: 403, gameCode: 'A', date: '2026-07-01', cooldownMs: 21_600_000, nextPendingDate: '2026-07-01' }));
    expect(f.source.historical).toHaveBeenCalledTimes(1);
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('pauses on exhausted 429, and otherwise continues ordinary date errors but stops fatal repository errors', async () => {
    const limited = fixture();
    limited.source.historical.mockRejectedValueOnce(new JerRateLimitError('limited', 429, games[0].detailUrl, 7_200_000));
    await expect(new BackfillJerResultsUseCase(limited.source as never, limited.repository as never, limited.dependencies).executeOperational()).resolves.toMatchObject({ status: 'PAUSED' });
    expect(limited.dependencies.transition429).toHaveBeenCalledWith('run-1', expect.objectContaining({ cooldownMs: 7_200_000, nextPendingDate: '2026-07-01' }));
    expect(limited.source.historical).toHaveBeenCalledTimes(1);

    const partial = fixture();
    partial.source.historical.mockRejectedValueOnce(new Error('bad date'));
    await expect(new BackfillJerResultsUseCase(partial.source as never, partial.repository as never, partial.dependencies).executeOperational()).resolves.toMatchObject({ status: 'PARTIAL', resultsInserted: 2 });
    expect(partial.source.historical).toHaveBeenCalledTimes(3);

    const fatal = fixture();
    fatal.repository.upsertResult.mockRejectedValueOnce(new Error('database down'));
    await expect(new BackfillJerResultsUseCase(fatal.source as never, fatal.repository as never, fatal.dependencies).executeOperational()).resolves.toMatchObject({ status: 'FAILED' });
    expect(fatal.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']);
  });

  it('records an invalid date page per game and processes valid pending dates from later games', async () => {
    const f = fixture();
    f.source.dates.mockRejectedValueOnce(new JerHtmlStructureChangedError('Date selector select[name="fecha"] was not found'));

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'PARTIAL', gamesQueried: 2, datesQueried: 1, resultsInserted: 1 });
    expect(summary.errors).toEqual(['A: Date selector select[name="fecha"] was not found']);
    expect(f.source.dates).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:B/2026-07-03']);
    expect(f.repository.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ errors: summary.errors }), 'PARTIAL');
    expect((f.dependencies.saveProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({ status: 'PARTIAL', failed: 1 });
  });

  it('gives a bound Scrape.do runtime one replacement request before transitioning a second target block', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: vi.fn(async () => undefined) }));
    f.source.historical.mockRejectedValueOnce(new JerBlockedError('first block', 403, games[0].detailUrl)).mockResolvedValueOnce(result(games[0], '2026-07-01'));

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'PAUSED', resultsInserted: 1 });
    expect(f.source.historical).toHaveBeenCalledTimes(2);
    expect(f.dependencies.transition403).not.toHaveBeenCalled();
  });

  it('persists pending Super after a threshold block and transitions without promoting during the same logical request', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: vi.fn(async () => undefined) }));
    const source = f.source as typeof f.source & { canRetryScrapedoBlockedRequest(): boolean };
    source.canRetryScrapedoBlockedRequest = vi.fn(() => false);
    source.historical.mockRejectedValueOnce(new JerBlockedError('threshold block', 403, games[0].detailUrl));

    const summary = await new BackfillJerResultsUseCase(source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'BLOCKED', sourceState: 'BLOCKED' });
    expect(source.canRetryScrapedoBlockedRequest).toHaveBeenCalledTimes(1);
    expect(source.historical).toHaveBeenCalledTimes(1);
    expect(f.dependencies.transition403).toHaveBeenCalledWith('scrapedo-run', expect.objectContaining({ error: 'threshold block', date: '2026-07-01' }));
  });

  it('transitions and stops after the replacement Scrape.do request is also target-blocked', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: vi.fn(async () => undefined) }));
    f.source.historical
      .mockRejectedValueOnce(new JerBlockedError('first block', 403, games[0].detailUrl))
      .mockRejectedValueOnce(new JerBlockedError('second block', 403, games[0].detailUrl));

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'BLOCKED', sourceState: 'BLOCKED' });
    expect(f.source.historical).toHaveBeenCalledTimes(2);
    expect(f.dependencies.transition403).toHaveBeenCalledWith('scrapedo-run', expect.objectContaining({ error: 'second block', date: '2026-07-01' }));
  });

  it('persists fresh-null and blocked session states before one distinct replacement, then transitions once without Super', async () => {
    const f = fixture({ maxResults: 1, batchSize: 1 });
    const generated = [101, 202];
    const generator: SessionIdGenerator = { next: excluded => {
      const value = generated.shift();
      if (value === undefined || excluded?.has(value)) throw new Error('unexpected generated session');
      return value;
    } };
    const fresh = { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: null, sessionStatus: 'INVALID', standardBlockedSessionCount: 0, pendingSuper: false } as unknown as ProviderStateV1;
    const providerWrites: Array<Parameters<ProviderStateWriter['save']>[0]> = [];
    const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined; attempt: SessionAttempt }> = [];
    const committer = new ProviderStateCommitter({ save: vi.fn(async write => {
      providerWrites.push(write);
      return { accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState };
    }) }, { nextRequestToken: (() => { let token = 0; return () => `provider-token-${++token}`; })() });
    const runtime = new ScrapedoRuntime({ policy: new ScrapedoSessionPolicy({ generator, maxStandardBlockedSessions: 2, superEnabled: true }), committer, retryDelayMs: 0, sleep: vi.fn(async () => undefined) });
    runtime.bind({ runId: 'scrapedo-run', ownerToken: 'owner-1', committed: { version: 1, requestToken: 'seed-token', providerState: fresh } });
    const transport = { requestRaw: vi.fn(async (url: string, init: RequestInit, _signal?: AbortSignal) => {
      if (init.method === 'POST') return { status: 403, headers: new Headers({ 'Scrape.do-Initial-Status-Code': '403', 'Scrape.do-Target-Url': url }), body: '' };
      return { status: 200, headers: new Headers(), body: 'ok' };
    }) };
    const history = { getDates: vi.fn(() => ['2026-07-01', '2026-07-02']), parse: vi.fn(() => result(games[0], '2026-07-01')) };
    const source = new JerSource({ get: vi.fn(), postForm: vi.fn() } as never, { parseGames: () => [games[0]], parseLatest: () => ({ results: [], rejected: [] }) } as never, history as never, 'https://jer.example/results', {
      runtime,
      progress: () => ({ attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' }),
      transportFactory: attempt => ({ requestRaw: async (url, init, signal) => {
        requests.push({ url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body === undefined ? undefined : String(init.body), attempt });
        return transport.requestRaw(url, init, signal);
      } }),
    });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: async (write: Parameters<typeof runtime.saveProgress>[0]) => { await runtime.saveProgress(write); } }));

    const summary = await new BackfillJerResultsUseCase(source, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ status: 'BLOCKED', sourceState: 'BLOCKED' });
    expect(requests).toEqual([
      { url: 'https://jer.example/results', method: 'GET', headers: {}, body: undefined, attempt: { sessionId: 101, tier: 'STANDARD', transportOptions: { super: false } } },
      { url: games[0].detailUrl, method: 'GET', headers: {}, body: undefined, attempt: { sessionId: 101, tier: 'STANDARD', transportOptions: { super: false } } },
      { url: games[0].detailUrl, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fecha=2026-07-01', attempt: { sessionId: 101, tier: 'STANDARD', transportOptions: { super: false } } },
      { url: games[0].detailUrl, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fecha=2026-07-01', attempt: { sessionId: 202, tier: 'STANDARD', transportOptions: { super: false } } },
    ]);
    expect(requests.filter(request => request.method === 'POST')).toEqual([
      { url: games[0].detailUrl, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fecha=2026-07-01', attempt: { sessionId: 101, tier: 'STANDARD', transportOptions: { super: false } } },
      { url: games[0].detailUrl, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fecha=2026-07-01', attempt: { sessionId: 202, tier: 'STANDARD', transportOptions: { super: false } } },
    ]);
    expect(requests.some(request => request.body?.includes('2026-07-02'))).toBe(false);
    expect(providerWrites).toEqual([
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 2, requestToken: 'provider-token-1', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', nextPendingDate: undefined, providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: null, sessionStatus: 'INVALID', standardBlockedSessionCount: 0, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 3, requestToken: 'provider-token-2', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 101, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 4, requestToken: 'provider-token-3', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 101, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 5, requestToken: 'provider-token-4', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', nextPendingDate: '2026-07-01', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 101, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 6, requestToken: 'provider-token-5', attempted: 1, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', nextPendingDate: '2026-07-01', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 101, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 7, requestToken: 'provider-token-6', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 101, sessionStatus: 'INVALID', standardBlockedSessionCount: 1, pendingSuper: false } },
      { runId: 'scrapedo-run', ownerToken: 'owner-1', version: 8, requestToken: 'provider-token-7', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 202, sessionStatus: 'INVALID', standardBlockedSessionCount: 2, pendingSuper: true } },
    ]);
    expect(f.dependencies.transition403).toHaveBeenCalledTimes(1);
    expect(f.dependencies.transition403).toHaveBeenCalledWith('scrapedo-run', { url: games[0].detailUrl, status: 403, gameCode: 'A', date: '2026-07-01', error: 'JER target returned HTTP 403', cooldownMs: 21_600_000, nextPendingDate: '2026-07-01' });
    expect(f.dependencies.transition429).toHaveBeenCalledTimes(0);
    expect(history.getDates).toHaveBeenCalledTimes(1);
    expect(history.parse).not.toHaveBeenCalled();
    expect(f.repository.upsertResult).not.toHaveBeenCalled();
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('stops the batch after a typed Scrape.do provider failure without source transitions or another request', async () => {
    const f = fixture();
    f.source.historical.mockRejectedValueOnce(new ScrapedoProviderError('provider'));

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary.status).toBe('FAILED');
    expect(f.source.historical).toHaveBeenCalledTimes(1);
    expect(f.dependencies.transition403).not.toHaveBeenCalled();
    expect(f.dependencies.transition429).not.toHaveBeenCalled();
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately and preserves the committed provider snapshot when provider-state persistence rejects', async () => {
    const f = fixture();
    const saveProgress = vi.fn(async () => { throw new Error('provider RPC rejected'); });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress }));

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ id: 'scrapedo-run', status: 'FAILED' });
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(f.source.discover).not.toHaveBeenCalled();
    expect(f.source.dates).not.toHaveBeenCalled();
    expect(f.source.historical).not.toHaveBeenCalled();
    expect(f.dependencies.transition403).not.toHaveBeenCalled();
    expect(f.dependencies.transition429).not.toHaveBeenCalled();
    expect(f.repository.finishRun).toHaveBeenCalledWith('scrapedo-run', expect.any(Object), 'FAILED');
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('fails operational backfill on a mismatched real committer receipt without mutating its snapshot or issuing provider work', async () => {
    const f = fixture();
    const original = { runId: 'scrapedo-run', ownerToken: 'owner-1', committed: { version: 1, requestToken: 'seed-token', providerState: { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: null, sessionStatus: 'INVALID', standardBlockedSessionCount: 0, pendingSuper: false } as ProviderStateV1 } };
    const expectedOriginal = structuredClone(original);
    const writer = { save: vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: 'mismatched-token', providerState: write.providerState })) };
    const committer = new ProviderStateCommitter(writer, { nextRequestToken: () => 'provider-token-1' });
    const runtime = new ScrapedoRuntime({ policy: new ScrapedoSessionPolicy({ generator: { next: () => 101 }, maxStandardBlockedSessions: 2, superEnabled: false }), committer, retryDelayMs: 0, sleep: vi.fn(async () => undefined) });
    runtime.bind(original);
    const providerTransport = { requestRaw: vi.fn() };
    const source = new JerSource({ get: vi.fn(), postForm: vi.fn() } as never, { parseGames: () => [games[0]], parseLatest: () => ({ results: [], rejected: [] }) } as never, { getDates: () => ['2026-07-01'], parse: () => result(games[0], '2026-07-01') } as never, 'https://jer.example/results', { runtime, progress: () => ({ attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' }), transportFactory: () => providerTransport });
    f.dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: async (write: ProgressWriteWithoutVersionTokenProviderState) => { await runtime.saveProgress(write); } }));

    const summary = await new BackfillJerResultsUseCase(source, f.repository as never, f.dependencies).executeOperational();

    expect(summary).toMatchObject({ id: 'scrapedo-run', status: 'FAILED' });
    expect(original).toEqual(expectedOriginal);
    expect(committer.current()).toEqual(expectedOriginal);
    expect(writer.save).toHaveBeenCalledOnce();
    expect(providerTransport.requestRaw).not.toHaveBeenCalled();
    expect(f.dependencies.transition403).not.toHaveBeenCalled();
    expect(f.dependencies.transition429).not.toHaveBeenCalled();
    expect(f.repository.finishRun).toHaveBeenCalledWith('scrapedo-run', expect.any(Object), 'FAILED');
    expect(f.dependencies.release).toHaveBeenCalledOnce();
  });

  it('makes a caller cancellation terminal rather than partial and issues no later request', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.source.historical.mockImplementationOnce(async () => {
      controller.abort(new Error('fake SIGINT'));
      throw controller.signal.reason;
    });

    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational({ signal: controller.signal });

    expect(summary).toMatchObject({ status: 'CANCELLED', resultsInserted: 0 });
    expect(f.source.historical).toHaveBeenCalledTimes(1);
    expect(f.dependencies.transition403).not.toHaveBeenCalled();
    expect(f.dependencies.transition429).not.toHaveBeenCalled();
    expect(f.repository.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'CANCELLED');
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('recomputes ascending missing dates from the current repository rather than a prior next-pending hint', async () => {
    const f = fixture({ priorSnapshot: { attempted: 99, nextPendingDate: '2026-07-03', status: 'PAUSED' } });
    f.repository.existingDates.mockImplementation(async (code: string) => code === 'A' ? ['2026-07-02'] : []);
    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01', 'POST:B/2026-07-03']);
    expect(f.dependencies.saveProgress).toHaveBeenCalledWith('run-1', expect.objectContaining({ attempted: 0, priorSnapshot: f.dependencies.priorSnapshot, totalMissing: 2 }));
  });

  it('persists one attempt progress save immediately before every POST, with strictly monotonic versions and request tokens', async () => {
    const f = fixture({ maxResults: 2, batchSize: 5 });
    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();

    const posts = f.calls.map((call, index) => ({ call, index })).filter(entry => entry.call.startsWith('POST:'));
    expect(posts).toHaveLength(2);
    for (const { index } of posts) expect(f.calls[index - 1]).toMatch(/^SAVE:\d+:[12]:token-\d+$/);
    expect(posts.map(({ index }) => f.calls[index - 1])).toEqual(['SAVE:3:1:token-3', 'SAVE:5:2:token-5']);
    const writes = (f.dependencies.saveProgress as ReturnType<typeof vi.fn>).mock.calls.map(([, progress]) => progress);
    expect(writes.map(progress => progress.version)).toEqual([...writes.keys()].map(index => index + 1));
    expect(new Set(writes.map(progress => progress.requestToken)).size).toBe(writes.length);
  });

  it('pauses at maxBatches with pending work and does not issue a later POST', async () => {
    const f = fixture({ batchSize: 1, maxBatches: 1, maxResults: 3 });
    await expect(new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational()).resolves.toMatchObject({ status: 'PAUSED', datesQueried: 1 });
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']);
  });

  it('does not issue the next POST until the fake 180000ms batch pause has elapsed', async () => {
    const pause = deferred<void>();
    const heartbeat = deferred<void>();
    const f = fixture({ batchSize: 1, maxBatches: 2, maxResults: 2, batchPauseMs: 180_000, sleep: vi.fn(async ms => { if (ms === 20_000) await heartbeat.promise; if (ms === 180_000) await pause.promise; }) });
    const running = new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    await vi.waitFor(() => expect((f.dependencies.sleep as ReturnType<typeof vi.fn>).mock.calls.filter(([ms]) => ms === 180_000)).toHaveLength(1));
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']);
    pause.resolve();
    await expect(running).resolves.toMatchObject({ status: 'PAUSED', datesQueried: 2 });
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01', 'POST:A/2026-07-02']);
  });

  it('checks the gate immediately before every GET and POST and prevents the request when later access is denied', async () => {
    const f = fixture();
    let gates = 0;
    f.dependencies.ensureActive = vi.fn(async () => {
      f.calls.push('GATE');
      gates++;
      return { state: gates === 4 ? 'BLOCKED' as const : 'ACTIVE' as const };
    });
    const summary = await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    expect(summary.status).toBe('FAILED');
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual([]);
    expect(f.calls.filter(call => call === 'GATE')).toHaveLength(4);
  });

  it('renews during work and an exact fake pause; a stale renewal aborts later requests and releases once', async () => {
    const pause = deferred<void>();
    const heartbeat = deferred<void>();
    const f = fixture({ batchSize: 1, maxBatches: 2, maxResults: 2, batchPauseMs: 180_000, leaseDurationMs: 60_000, renewIntervalMs: 20_000, sleep: vi.fn(async (ms, signal) => {
      if (ms === 20_000) await heartbeat.promise;
      if (ms === 180_000) await Promise.race([pause.promise, new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    }) });
    const running = new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    await vi.waitFor(() => expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']));
    await vi.waitFor(() => expect(f.dependencies.sleep).toHaveBeenCalledWith(20_000, expect.any(AbortSignal)));
    (f.dependencies.renew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    heartbeat.resolve();
    await expect(running).resolves.toMatchObject({ status: 'FAILED' });
    expect(f.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']);
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });

  it('persists complete exhausted-429 telemetry and retains a prior success when a later fatal save fails', async () => {
    const limited = fixture();
    limited.source.historical.mockImplementationOnce(async (game, date) => { limited.calls.push(`POST:${game.code}/${date}`); throw new JerRateLimitError('limited', 429, games[0].detailUrl, 7_200_000); });
    await new BackfillJerResultsUseCase(limited.source as never, limited.repository as never, limited.dependencies).executeOperational();
    expect(limited.dependencies.transition429).toHaveBeenCalledWith('run-1', { url: games[0].detailUrl, status: 429, gameCode: 'A', date: '2026-07-01', error: 'limited', cooldownMs: 7_200_000, nextPendingDate: '2026-07-01' });
    expect(limited.calls.filter(call => call.startsWith('POST:'))).toEqual(['POST:A/2026-07-01']);

    const fatal = fixture();
    fatal.repository.upsertResult.mockResolvedValueOnce('inserted').mockRejectedValueOnce(new Error('database down'));
    const summary = await new BackfillJerResultsUseCase(fatal.source as never, fatal.repository as never, fatal.dependencies).executeOperational();
    expect(summary).toMatchObject({ status: 'FAILED', resultsInserted: 1 });
    expect((fatal.dependencies.saveProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({ status: 'FAILED', inserted: 1, attempted: 2 });
  });

  it('resets every current counter while preserving an immutable complete prior snapshot', async () => {
    const priorSnapshot = Object.freeze({ attempted: 99, inserted: 88, updated: 77, skipped: 66, failed: 55, gamesQueried: 44, datesQueried: 33, processedBatches: 22, totalMissing: 11, nextPendingDate: '2026-07-03', status: 'SUCCESS' });
    const f = fixture({ priorSnapshot, maxResults: 1, batchSize: 1 });
    await new BackfillJerResultsUseCase(f.source as never, f.repository as never, f.dependencies).executeOperational();
    const first = (f.dependencies.saveProgress as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(first).toMatchObject({ attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, gamesQueried: 0, datesQueried: 0, processedBatches: 0, totalMissing: 0, priorSnapshot });
    expect(priorSnapshot).toEqual({ attempted: 99, inserted: 88, updated: 77, skipped: 66, failed: 55, gamesQueried: 44, datesQueried: 33, processedBatches: 22, totalMissing: 11, nextPendingDate: '2026-07-03', status: 'SUCCESS' });
  });
});
