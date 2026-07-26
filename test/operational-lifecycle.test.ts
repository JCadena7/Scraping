import { describe, expect, it, vi } from 'vitest';
import { JerBlockedError, JerRateLimitError } from '../src/jer/domain.js';
import { JerHttpClient } from '../src/jer/http-client.js';
import {
  InMemoryProgressStore,
  OwnerFinalizer,
  RenewableLeaseHeartbeat,
  executeGuarded,
  toOperationalOutcome,
  type Clock,
  type ProgressWrite
} from '../src/jer/operational-lifecycle.js';

function deferredClock(): { clock: Clock; advance: () => Promise<void> } {
  const waits: Array<() => void> = [];
  return {
    clock: { now: () => 0, sleep: async () => new Promise<void>(resolve => waits.push(resolve)) },
    advance: async () => { waits.shift()?.(); await Promise.resolve(); await Promise.resolve(); }
  };
}

describe('operational lifecycle seams', () => {
  it('checks the source gate at startup and again before a later operation', async () => {
    const ensureActive = vi.fn()
      .mockResolvedValueOnce({ state: 'ACTIVE' as const })
      .mockResolvedValueOnce({ state: 'BLOCKED' as const, blockedUntil: 1 });
    const operation = vi.fn(async () => 'network result');

    await expect(executeGuarded({ ensureActive }, operation, { now: () => 100 })).resolves.toBe('network result');
    await expect(executeGuarded({ ensureActive }, operation, { now: () => 200 })).rejects.toThrow('Source is BLOCKED');
    expect(ensureActive).toHaveBeenNthCalledWith(1, 100);
    expect(ensureActive).toHaveBeenNthCalledWith(2, 200);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('maps explicit 403 and exhausted 429 tuples to source, run, and exit outcomes', () => {
    expect(toOperationalOutcome(new JerBlockedError('blocked', 403, 'https://jer.com.co/x'))).toEqual({ sourceState: 'BLOCKED', runStatus: 'BLOCKED', exitCode: 3 });
    expect(toOperationalOutcome(new JerRateLimitError('limited', 429, 'https://jer.com.co/x', 7000))).toEqual({ sourceState: 'RATE_LIMITED', runStatus: 'PAUSED', exitCode: 4, retryAfterMs: 7000 });
  });

  it('renews the owner lease on its fake clock while work is delayed and aborts on a stale renewal', async () => {
    const { clock, advance } = deferredClock();
    const controller = new AbortController();
    const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const onFatal = vi.fn();
    const heartbeat = new RenewableLeaseHeartbeat({ ownerToken: 'owner', renew, controller, clock, onFatal });

    heartbeat.start();
    await advance();
    await advance();
    await advance();

    expect(renew).toHaveBeenCalledTimes(2);
    expect(controller.signal.aborted).toBe(true);
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'Lease renewal was rejected' }));
    heartbeat.stop();
  });

  it('uses default sixty-second lease and twenty-second renewal contracts', () => {
    const heartbeat = new RenewableLeaseHeartbeat({ ownerToken: 'owner', renew: async () => true, controller: new AbortController(), clock: { now: () => 0, sleep: async () => undefined }, onFatal: vi.fn() });
    expect(heartbeat.contract).toEqual({ leaseDurationMs: 60000, renewIntervalMs: 20000 });
  });

  it('aborts and reports renewal errors, but lets an already-observed cancellation win', async () => {
    const failure = new Error('renew transport failed');
    const first = deferredClock();
    const firstController = new AbortController();
    const onFatal = vi.fn();
    const failingHeartbeat = new RenewableLeaseHeartbeat({ ownerToken: 'owner', renew: async () => { throw failure; }, controller: firstController, clock: first.clock, onFatal });
    failingHeartbeat.start();
    await first.advance();
    await first.advance();
    expect(firstController.signal.aborted).toBe(true);
    expect(onFatal).toHaveBeenCalledWith(failure);

    const second = deferredClock();
    const secondController = new AbortController();
    const cancelledFatal = vi.fn();
    const cancelledHeartbeat = new RenewableLeaseHeartbeat({ ownerToken: 'owner', renew: async () => false, controller: secondController, clock: second.clock, onFatal: cancelledFatal });
    cancelledHeartbeat.start();
    secondController.abort(new Error('SIGTERM'));
    await second.advance();
    expect(cancelledFatal).not.toHaveBeenCalled();
  });

  it('renews with one shared abort signal throughout request delay, batch pause, Retry-After, and an in-flight fetch', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const renew = vi.fn(async () => true);
      const clock: Clock = { now: () => Date.now(), sleep: (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }) };
      const heartbeat = new RenewableLeaseHeartbeat({ ownerToken: 'owner', renew, controller, clock, onFatal: vi.fn() });
      let resolveFetch!: (response: Response) => void;
      const inFlight = new Promise<Response>(resolve => { resolveFetch = resolve; });
      const delayedClient = new JerHttpClient({ timeoutMs: 120000, delayMs: 60000, maxRetries: 0, userAgent: 'test', fetchImpl: vi.fn(() => inFlight), sleepImpl: clock.sleep });
      heartbeat.start();
      const delayedRequest = delayedClient.get('https://jer.com.co/delay', controller.signal);
      await vi.advanceTimersByTimeAsync(60000);
      expect(renew).toHaveBeenCalledTimes(3);
      resolveFetch(new Response('delayed', { status: 200 }));
      await expect(delayedRequest).resolves.toBe('delayed');

      const batchPause = clock.sleep(40000, controller.signal);
      await vi.advanceTimersByTimeAsync(40000);
      await expect(batchPause).resolves.toBeUndefined();
      expect(renew).toHaveBeenCalledTimes(5);

      const retryClient = new JerHttpClient({ timeoutMs: 120000, delayMs: 0, maxRetries: 1, userAgent: 'test', fetchImpl: vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } })).mockResolvedValueOnce(new Response('retried', { status: 200 })), sleepImpl: clock.sleep });
      const retry = retryClient.get('https://jer.com.co/retry-after', controller.signal);
      await vi.advanceTimersByTimeAsync(30000);
      await expect(retry).resolves.toBe('retried');
      expect(renew).toHaveBeenCalledTimes(6);
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes cancellation once: signal aborts work, persists CANCELLED, and releases even when persistence fails', async () => {
    const controller = new AbortController();
    const heartbeat = { stop: vi.fn() };
    const persistCancelled = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const release = vi.fn().mockResolvedValue(undefined);
    const finalizer = new OwnerFinalizer({ controller, heartbeat, persistCancelled, release });

    await expect(finalizer.cancel(new Error('SIGINT'))).resolves.toBe(130);
    await expect(finalizer.cancel(new Error('SIGTERM'))).resolves.toBe(130);
    expect(controller.signal.aborted).toBe(true);
    expect(heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(persistCancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets an already-observed signal win over a later successful terminal outcome', async () => {
    const controller = new AbortController();
    controller.abort(new Error('SIGTERM'));
    const persistCancelled = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const finalizer = new OwnerFinalizer({ controller, heartbeat: { stop: vi.fn() }, persistCancelled, release });

    await expect(finalizer.complete(0)).resolves.toBe(130);
    expect(persistCancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('accepts absolute progress once, treats duplicate saves as idempotent, and rejects stale owner or version', () => {
    const store = new InMemoryProgressStore();
    const write: ProgressWrite = { ownerToken: 'owner-a', version: 1, absoluteCounters: { attempted: 3, inserted: 2 }, status: 'RUNNING' };

    expect(store.save(write)).toEqual({ accepted: true, duplicate: false });
    expect(store.save(write)).toEqual({ accepted: true, duplicate: true });
    expect(() => store.save({ ...write, ownerToken: 'owner-b', version: 2 })).toThrow('Stale progress owner');
    expect(() => store.save({ ...write, version: 0 })).toThrow('Stale progress version');
    expect(store.snapshot).toEqual(write);
  });
});
