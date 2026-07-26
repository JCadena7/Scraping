import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JerBlockedError, JerRateLimitError } from '../src/jer/domain.js';
import { JerHttpClient } from '../src/jer/http-client.js';
import { persistOperationalFailure, runCli, parseArgs, parseOperationalOverrides, runWithSignals } from '../src/jer/cli.js';
import { BackfillJerResultsUseCase, SyncJerLatestResultsUseCase } from '../src/jer/use-cases.js';

const options = (fetchImpl: typeof fetch, delayMs = 0) => ({ timeoutMs: 1_000, delayMs, maxRetries: 1, userAgent: 'test', fetchImpl });
const game = { code: 'CHONTICO_DIA', name: 'Chontico Día', type: 'CHANCE' as const, detailUrl: 'https://jer.example/resultados/chontico-dia/', active: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('JerHttpClient cancellation', () => {
  it('does not admit or fetch a pre-aborted request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const client = new JerHttpClient(options(fetchImpl));

    await expect(client.get('https://jer.example/pre-aborted', controller.signal)).rejects.toThrow('stop');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes an aborted queued request and lets later same-domain work continue', async () => {
    const first = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValue(new Response('later', { status: 200 }));
    const client = new JerHttpClient(options(fetchImpl));
    const controller = new AbortController();

    const active = client.get('https://jer.example/active');
    const cancelled = client.get('https://jer.example/cancelled', controller.signal);
    const later = client.get('https://jer.example/later');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled'));
    first.resolve(new Response('active', { status: 200 }));

    await expect(active).resolves.toBe('active');
    await expect(cancelled).rejects.toThrow('cancelled');
    await expect(later).resolves.toBe('later');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not fetch after cancellation during a configured delay or retry backoff', async () => {
    const delay = deferred<void>();
    const delayImpl = vi.fn(() => delay.promise);
    const delayedFetch = vi.fn<typeof fetch>();
    const delayed = new JerHttpClient({ ...options(delayedFetch, 100), sleepImpl: delayImpl });
    const delayedAbort = new AbortController();
    const delayedRequest = delayed.get('https://jer.example/delay', delayedAbort.signal);
    await vi.waitFor(() => expect(delayImpl).toHaveBeenCalledTimes(1));
    delayedAbort.abort(new Error('delay cancelled'));
    delay.resolve();
    await expect(delayedRequest).rejects.toThrow('delay cancelled');
    expect(delayedFetch).not.toHaveBeenCalled();

    const backoff = deferred<void>();
    const backoffDelay = vi.fn(() => backoff.promise);
    const retryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('retry', { status: 500 }));
    const retrying = new JerHttpClient({ ...options(retryFetch), sleepImpl: backoffDelay });
    const retryAbort = new AbortController();
    const retryRequest = retrying.get('https://jer.example/retry', retryAbort.signal);
    await vi.waitFor(() => expect(backoffDelay).toHaveBeenCalledTimes(1));
    retryAbort.abort(new Error('retry cancelled'));
    backoff.resolve();
    await expect(retryRequest).rejects.toThrow('retry cancelled');
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });
});

describe('CLI filters and status', () => {
  it.each([
    ['discover', new JerBlockedError('blocked', 403, 'https://jer.example'), 3, 'transitionJer403'],
    ['discover', new JerRateLimitError('limited', 429, 'https://jer.example', 7_200_000), 4, 'transitionJer429'],
    ['latest', new JerBlockedError('blocked', 403, 'https://jer.example'), 3, 'transitionJer403'],
    ['latest', new JerRateLimitError('limited', 429, 'https://jer.example', 7_200_000), 4, 'transitionJer429'],
  ] as const)('persists and maps terminal HTTP failure for %s', async (command, error, exit, transition) => {
    const repository = { transitionJer403: vi.fn(async () => true), transitionJer429: vi.fn(async () => true) };
    const outcome = await persistOperationalFailure(repository as never, 'owner', command === 'latest' ? 'run-1' : undefined, error, { blockCooldownMs: 3_600_000, rateLimitCooldownMs: 60_000 });
    const dependencies = { discover: vi.fn(async () => outcome), latest: vi.fn(async () => outcome), backfill: vi.fn(), print: vi.fn(), error: vi.fn() };
    await expect(runCli([command], dependencies)).resolves.toBe(exit);
    expect(repository[transition]).toHaveBeenCalledWith('owner', command === 'latest' ? 'run-1' : undefined, expect.any(Number), error.message);
  });

  it.each([
    new JerBlockedError('blocked', 403, 'https://jer.example'),
    new JerRateLimitError('limited', 429, 'https://jer.example'),
  ])('leaves latest terminal persistence to the transition RPC for %s', async error => {
    const source = { mainSnapshot: vi.fn(async () => { throw error; }) };
    const repository = { startRun: vi.fn(), finishRun: vi.fn() };
    await expect(new SyncJerLatestResultsUseCase(source as never, repository as never).execute(undefined, 'run-1')).rejects.toBe(error);
    expect(repository.startRun).not.toHaveBeenCalled();
    expect(repository.finishRun).not.toHaveBeenCalled();
  });

  it('accepts documented short operational overrides and rejects malformed or unknown values before command execution', async () => {
    expect(parseOperationalOverrides({ 'batch-size': '7', 'max-batches': '2', 'max-results': '9' })).toMatchObject({ batchSize: 7, maxBatchesPerRun: 2, maxResultsPerRun: 9 });
    expect(() => parseOperationalOverrides({ 'batch-size': '0' })).toThrow();
    expect(() => parseOperationalOverrides({ 'max-results': 'many' })).toThrow();

    const dependencies = { latest: vi.fn(), backfill: vi.fn(), discover: vi.fn(), print: vi.fn(), error: vi.fn() };
    await expect(runCli(['backfill', '--batch-size=0'], dependencies)).rejects.toThrow();
    await expect(runCli(['backfill', '--max-result=9'], dependencies)).rejects.toThrow('Unknown JER operational override: max-result');
    expect(dependencies.backfill).not.toHaveBeenCalled();
  });

  it('maps source-limited pauses separately from ordinary operational-limit pauses', async () => {
    const dependencies = { latest: vi.fn(), discover: vi.fn(), print: vi.fn(), error: vi.fn(), backfill: vi.fn()
      .mockResolvedValueOnce({ status: 'PAUSED', sourceState: 'RATE_LIMITED' })
      .mockResolvedValueOnce({ status: 'PAUSED' }) };
    await expect(runCli(['backfill'], dependencies)).resolves.toBe(4);
    await expect(runCli(['backfill'], dependencies)).resolves.toBe(0);
  });

  it('uses the same blocked, rate-limited, and foreign-lease exits for discover before any network result is printed', async () => {
    const dependencies = { latest: vi.fn(), backfill: vi.fn(), error: vi.fn(), print: vi.fn(), discover: vi.fn()
      .mockResolvedValueOnce({ status: 'BLOCKED', sourceState: 'BLOCKED' })
      .mockResolvedValueOnce({ status: 'FAILED', sourceState: 'RATE_LIMITED' })
      .mockResolvedValueOnce({ status: 'FAILED', sourceState: 'ACTIVE' }) };
    await expect(runCli(['discover'], dependencies)).resolves.toBe(3);
    await expect(runCli(['discover'], dependencies)).resolves.toBe(4);
    await expect(runCli(['discover'], dependencies)).resolves.toBe(1);
    expect(dependencies.discover).toHaveBeenCalledTimes(3);
  });

  it('injects SIGINT into one shared abort controller and removes handlers after finalization', async () => {
    const handlers = new Map<string, () => void>();
    const processLike = { on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }), removeListener: vi.fn((event: string) => { handlers.delete(event); }) };
    let signal!: AbortSignal;
    const running = runWithSignals(async current => { signal = current; handlers.get('SIGINT')?.(); return 0; }, processLike);

    await expect(running).resolves.toBe(130);
    expect(signal.aborted).toBe(true);
    expect(processLike.removeListener).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processLike.removeListener).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('rejects unknown backfill filters from the persisted catalog before JER discovery', async () => {
    const source = { discover: vi.fn(), dates: vi.fn(), historical: vi.fn() };
    const repository = {
      startRun: vi.fn(async () => 'run'), finishRun: vi.fn(async () => undefined), upsertGames: vi.fn(async () => undefined),
      listGames: vi.fn(async () => [game]), existingDates: vi.fn(), upsertResult: vi.fn(),
    };
    const summary = await new BackfillJerResultsUseCase(source as never, repository as never).execute({ games: ['UNKNOWN'] });

    expect(summary.status).toBe('FAILED');
    expect(summary.errors).toEqual(['Unknown requested game code(s): UNKNOWN']);
    expect(source.discover).not.toHaveBeenCalled();
  });

  it('returns failed when a requested filter has no persisted catalog to validate against', async () => {
    const source = { discover: vi.fn(), dates: vi.fn(), historical: vi.fn() };
    const repository = {
      startRun: vi.fn(async () => 'run'), finishRun: vi.fn(async () => undefined), upsertGames: vi.fn(async () => undefined),
      listGames: vi.fn(async () => []), existingDates: vi.fn(), upsertResult: vi.fn(),
    };
    const summary = await new BackfillJerResultsUseCase(source as never, repository as never).execute({ games: ['CHONTICO_DIA'] });

    expect(summary.status).toBe('FAILED');
    expect(summary.errors).toEqual(['Cannot validate requested game filters because the persisted JER catalog is empty; run discover first']);
    expect(source.discover).not.toHaveBeenCalled();
  });

  it('stops remaining dates and records FAILED when the supplied signal aborts during a date', async () => {
    const controller = new AbortController();
    const historical = vi.fn(async () => { controller.abort(new Error('cancelled')); throw controller.signal.reason; });
    const source = { discover: vi.fn(async () => [game]), dates: vi.fn(async () => ['2026-07-23', '2026-07-24']), historical };
    const repository = {
      startRun: vi.fn(async () => 'run'), finishRun: vi.fn(async () => undefined), upsertGames: vi.fn(async () => undefined),
      existingDates: vi.fn(async () => []), upsertResult: vi.fn(async () => 'inserted'),
    };

    const summary = await new BackfillJerResultsUseCase(source as never, repository as never).execute({ signal: controller.signal });

    expect(summary.status).toBe('FAILED');
    expect(historical).toHaveBeenCalledTimes(1);
    expect(repository.finishRun).toHaveBeenCalledWith('run', expect.any(Object), 'FAILED');
  });

  it('maps latest and backfill SUCCESS, FAILED, and PARTIAL summaries to documented exit codes', async () => {
    const latest = vi.fn();
    const backfill = vi.fn();
    const dependencies = { latest, backfill, discover: vi.fn(), print: vi.fn(), error: vi.fn() };
    latest.mockResolvedValueOnce({ status: 'SUCCESS' }).mockResolvedValueOnce({ status: 'FAILED' }).mockResolvedValueOnce({ status: 'PARTIAL' });
    backfill.mockResolvedValueOnce({ status: 'SUCCESS' }).mockResolvedValueOnce({ status: 'FAILED' }).mockResolvedValueOnce({ status: 'PARTIAL' });

    await expect(runCli(['latest'], dependencies)).resolves.toBe(0);
    await expect(runCli(['latest'], dependencies)).resolves.toBe(1);
    await expect(runCli(['latest'], dependencies)).resolves.toBe(2);
    await expect(runCli(['backfill', '--game=CHONTICO_DIA'], dependencies)).resolves.toBe(0);
    await expect(runCli(['backfill', '--game=CHONTICO_DIA'], dependencies)).resolves.toBe(1);
    await expect(runCli(['backfill', '--game=CHONTICO_DIA'], dependencies)).resolves.toBe(2);
  });

  it.each(['discover', 'latest', 'backfill'] as const)('maps disabled, foreign-lease, blocked, and rate-limited outcomes for %s', async command => {
    const dependencies = {
      latest: vi.fn(), backfill: vi.fn(), discover: vi.fn(), print: vi.fn(), error: vi.fn(),
    };
    const outcomes = [
      { status: 'FAILED', sourceState: 'DISABLED' },
      { status: 'FAILED', sourceState: 'ACTIVE' },
      { status: 'BLOCKED', sourceState: 'BLOCKED' },
      { status: 'PAUSED', sourceState: 'RATE_LIMITED' },
    ];
    const invoke = command === 'discover' ? dependencies.discover : command === 'latest' ? dependencies.latest : dependencies.backfill;
    invoke.mockResolvedValueOnce(outcomes[0]).mockResolvedValueOnce(outcomes[1]).mockResolvedValueOnce(outcomes[2]).mockResolvedValueOnce(outcomes[3]);

    await expect(runCli([command], dependencies)).resolves.toBe(1);
    await expect(runCli([command], dependencies)).resolves.toBe(1);
    await expect(runCli([command], dependencies)).resolves.toBe(3);
    await expect(runCli([command], dependencies)).resolves.toBe(4);
  });

  it('documents cancellation as CANCELLED exit 130 and reserves exit 1 for ordinary failures', () => {
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('| `1` | `FAILED` | Invalid command, configuration, filter, disabled source, foreign live lease, or ordinary failure. |');
    expect(readme).toContain('| `130` | `CANCELLED` | SIGINT or SIGTERM stopped the active command cleanly. |');
    expect(readme).not.toContain('filter, cancellation, or complete failure');
  });

  it('parses actual discovered game codes without losing comma-separated filters', () => {
    expect(parseArgs(['--game=CHONTICO_DIA', '--games=CHONTICO_DIA,CHONTICO_NOCHE', '--from=2026-07-01'])).toEqual({
      game: 'CHONTICO_DIA', games: 'CHONTICO_DIA,CHONTICO_NOCHE', from: '2026-07-01',
    });
  });
});
