import { describe, expect, it, vi } from 'vitest';
import { assertScrapedoCommandAllowed, createOperationalDependencies, main, runCli, runWithSignals } from '../src/jer/cli.js';
import type { JerConfig } from '../src/jer/config.js';
import { BackfillJerResultsUseCase, JerSource, type BackfillOperationalDependencies } from '../src/jer/use-cases.js';
import type { DiscoveredGame, NormalizedDrawResult } from '../src/jer/domain.js';
import { ProviderStateCommitter, ScrapedoRuntime, type ProgressWriteWithoutVersionTokenProviderState } from '../src/jer/scrapedo-runtime.js';
import { ScrapedoSessionPolicy, type ProviderStateV1 } from '../src/jer/session-policy.js';

const config = {
  timeoutMs: 1_000,
  delayMs: 5_000,
  maxRetries: 5,
  userAgent: 'test-agent',
  provider: { kind: 'SCRAPEDO', endpoint: 'https://api.scrape.do/', token: 'not-logged', superEnabled: false, maxStandardBlockedSessions: 2, maxRetries: 1 }
} as Pick<JerConfig, 'timeoutMs' | 'delayMs' | 'maxRetries' | 'userAgent' | 'provider'>;

const game: DiscoveredGame = { code: 'A', name: 'A', type: 'CHANCE', detailUrl: 'https://jer.example/a', active: true };
const result: NormalizedDrawResult = { gameCode: 'A', gameName: 'A', gameType: 'CHANCE', drawDate: '2026-07-01', winningNumber: '1234', sourceUrl: game.detailUrl, sourceHash: 'A/2026-07-01', fetchedAt: new Date('2026-07-25T00:00:00.000Z'), verified: true };

function cancelledOperationalHarness(signalName: 'SIGINT' | 'SIGTERM') {
  const listeners = new Map<string, () => void>();
  const processLike = { on: vi.fn((event, listener) => { listeners.set(event, listener); }), removeListener: vi.fn((event) => { listeners.delete(event); }) };
  const providerAttempts = vi.fn();
  const sessionGenerator = { next: vi.fn(() => 202) };
  const providerState: ProviderStateV1 = { schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.example', tier: 'STANDARD', sessionId: 101, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false };
  const writer = { save: vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState })) };
  const committer = new ProviderStateCommitter(writer, { nextRequestToken: (() => { let token = 0; return () => `provider-token-${++token}`; })() });
  const runtime = new ScrapedoRuntime({ policy: new ScrapedoSessionPolicy({ generator: sessionGenerator, maxStandardBlockedSessions: 2, superEnabled: false }), committer, retryDelayMs: 0, sleep: vi.fn(async () => undefined) });
  runtime.bind({ runId: 'scrapedo-run', ownerToken: 'owner-1', committed: { version: 1, requestToken: 'seed-token', providerState } });
  const transportFactory = vi.fn(() => ({ requestRaw: vi.fn(async (_url: string, init: RequestInit, signal?: AbortSignal) => {
      providerAttempts();
      if (init.method === 'POST') listeners.get(signalName)?.();
      if (signal?.aborted) throw signal.reason;
      return { status: 200, headers: new Headers(), body: 'ok' };
    }) }));
  const source = new JerSource({ get: vi.fn(), postForm: vi.fn() } as never, { parseGames: () => [game], parseLatest: () => ({ results: [], rejected: [] }) } as never, { getDates: () => ['2026-07-01', '2026-07-02'], parse: () => result } as never, 'https://jer.example/results', { runtime, progress: () => ({ attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' }), transportFactory });
  const repository = { startRun: vi.fn(async () => 'run-1'), upsertGames: vi.fn(async () => undefined), existingDates: vi.fn(async () => [] as string[]), upsertResult: vi.fn(async () => 'inserted' as const), finishRun: vi.fn(async () => undefined) };
  const dependencies: BackfillOperationalDependencies = {
    ownerToken: 'owner-1', leaseDurationMs: 60_000, renewIntervalMs: 20_000, batchSize: 2, maxBatches: 2, maxResults: 2, batchPauseMs: 0, blockCooldownMs: 1, rateLimitCooldownMs: 1,
    nextRequestToken: vi.fn(() => 'request-1'), acquireAndGate: vi.fn(async () => ({ acquired: true, state: 'ACTIVE' as const })), ensureActive: vi.fn(async () => ({ state: 'ACTIVE' as const })), renew: vi.fn(async () => true), release: vi.fn(async () => undefined), saveProgress: vi.fn(async () => undefined), transition403: vi.fn(async () => undefined), transition429: vi.fn(async () => undefined), sleep: vi.fn(async () => undefined),
  };
  dependencies.startProviderRun = vi.fn(async () => ({ runId: 'scrapedo-run', saveProgress: async (write: ProgressWriteWithoutVersionTokenProviderState) => { await runtime.saveProgress(write); } }));
  const backfill = vi.fn((options: { games?: string[]; from?: string; to?: string; signal?: AbortSignal }) => new BackfillJerResultsUseCase(source, repository as never, dependencies).executeOperational(options));
  return { processLike, providerAttempts, sessionGenerator, transportFactory, repository, dependencies, backfill };
}

describe('JER CLI operational boundary', () => {
   it.each(['discover', 'latest'])('rejects Scrape.do %s before any operational factory can be reached', command => {
     expect(() => assertScrapedoCommandAllowed(command, { kind: 'SCRAPEDO' })).toThrow('Scrape.do is available only for backfill');
   });
   it.each(['discover', 'latest'])('gates Scrape.do %s before Supabase, repository, or transport construction', async command => {
     const createClient = vi.fn();
     const createRepository = vi.fn();
     await expect(main({ argv: [command], env: { JER_PROVIDER: 'SCRAPEDO', JER_SCRAPEDO_TOKEN: 'test-token' }, createClient, createRepository })).rejects.toThrow('Scrape.do is available only for backfill');
     expect(createClient).not.toHaveBeenCalled();
     expect(createRepository).not.toHaveBeenCalled();
   });
  it('keeps the direct progress RPC on the legacy path', async () => {
    const repository = { saveJerProgress: vi.fn(async () => undefined) };
    const dependencies = createOperationalDependencies(repository as never, { ...config, provider: { kind: 'DIRECT' } } as JerConfig);
     await dependencies.saveProgress('run-1', { version: 1, requestToken: 'request-1', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', gamesQueried: 0, datesQueried: 0, processedBatches: 0, totalMissing: 0 });
      expect(repository.saveJerProgress).toHaveBeenCalledOnce();
    });

    it.each(['SIGINT', 'SIGTERM'] as const)('drives %s through runWithSignals, runCli backfill, and executeOperational as a terminal cancellation without an OS signal', async signalName => {
      const f = cancelledOperationalHarness(signalName);
      const operation = vi.fn((signal: AbortSignal) => runCli(['backfill'], { discover: vi.fn(), latest: vi.fn(), backfill: f.backfill, print: vi.fn(), error: vi.fn() }, signal));

      await expect(runWithSignals(operation, f.processLike)).resolves.toBe(130);
      expect(operation).toHaveBeenCalledOnce();
      expect(f.backfill).toHaveBeenCalledOnce();
      expect(f.providerAttempts).toHaveBeenCalledTimes(3);
      expect(f.sessionGenerator.next).not.toHaveBeenCalled();
      expect(f.dependencies.transition403).not.toHaveBeenCalled();
      expect(f.dependencies.transition429).not.toHaveBeenCalled();
      await expect(f.backfill.mock.results[0].value).resolves.toMatchObject({ status: 'CANCELLED' });
      expect(f.repository.finishRun).toHaveBeenCalledWith('scrapedo-run', expect.any(Object), 'CANCELLED');
      expect(f.repository.finishRun).not.toHaveBeenCalledWith('scrapedo-run', expect.any(Object), 'PARTIAL');
      expect(f.dependencies.release).toHaveBeenCalledOnce();
      expect(f.dependencies.startProviderRun).toHaveBeenCalledOnce();
      expect(f.processLike.on).toHaveBeenCalledTimes(2);
      expect(f.processLike.removeListener).toHaveBeenCalledTimes(2);
    });
});
