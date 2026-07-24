import { describe, expect, it, vi } from 'vitest';
import { JerHttpClient } from '../src/jer/http-client.js';
import { runCli, parseArgs } from '../src/jer/cli.js';
import { BackfillJerResultsUseCase } from '../src/jer/use-cases.js';

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

  it('parses actual discovered game codes without losing comma-separated filters', () => {
    expect(parseArgs(['--game=CHONTICO_DIA', '--games=CHONTICO_DIA,CHONTICO_NOCHE', '--from=2026-07-01'])).toEqual({
      game: 'CHONTICO_DIA', games: 'CHONTICO_DIA,CHONTICO_NOCHE', from: '2026-07-01',
    });
  });
});
