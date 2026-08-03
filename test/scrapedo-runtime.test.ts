import { describe, expect, it, vi } from 'vitest';
import type { ProviderStateV1, SessionAttempt, SessionAttemptOutcome } from '../src/jer/session-policy.js';
import {
  ProviderStateCommitter,
  ScrapedoProviderError,
  ScrapedoRuntime,
  classifyScrapedoFailure,
  classifyScrapedoResponse,
  type JerOperation,
} from '../src/jer/scrapedo-runtime.js';

const state: ProviderStateV1 = {
  schemaVersion: 1, provider: 'SCRAPEDO', targetOrigin: 'https://jer.com.co', tier: 'STANDARD', sessionId: 7,
  sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false,
};
const snapshot = { runId: 'run', ownerToken: 'owner', committed: { version: 4, requestToken: 'token-4', providerState: state } };
const progress = { attempted: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' };

function operation<T>(classification: Exclude<JerOperation<T>['classification'], 'valid_results' | 'valid_no_results'>): JerOperation<T> {
  return { ok: false, classification, error: new ScrapedoProviderError() } as JerOperation<T>;
}

describe('Scrape.do runtime foundation', () => {
  it('fails unbound before constructing or calling an attempt', async () => {
    const attemptFactory = vi.fn();
    const runtime = new ScrapedoRuntime({ policy: { execute: vi.fn() }, committer: new ProviderStateCommitter({ save: vi.fn() }) as never, attemptFactory, retryDelayMs: 5, sleep: vi.fn() });

    await expect(runtime.execute(progress)).resolves.toMatchObject({ ok: false, classification: 'provider_error' });
    expect(attemptFactory).not.toHaveBeenCalled();
  });

  it.each([
    [403, { 'Scrape.do-Initial-Status-Code': '403', 'Scrape.do-Target-Url': 'https://jer.com.co/a' }, 'blocked'],
    [429, { 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': 'https://jer.com.co/a' }, 'rate_limited'],
    [429, {}, 'concurrency_error'],
    [401, {}, 'provider_error'],
    [502, {}, 'provider_error'],
    [510, {}, 'provider_error'],
    [400, {}, 'provider_error'],
  ] as const)('maps status %i using closed precedence to %s', (status, headers, classification) => {
    expect(classifyScrapedoResponse({ status, headers: new Headers(headers), body: '' }, 'https://jer.com.co/a', () => ({ ok: true, classification: 'valid_results', value: 'result' }))).toMatchObject({ ok: false, classification });
  });

  it.each(['403x', '0403', '-403', '700', '403.0'])('rejects malformed or out-of-range documented target status %s', initialStatus => {
    expect(classifyScrapedoResponse({ status: 403, headers: new Headers({ 'Scrape.do-Initial-Status-Code': initialStatus, 'Scrape.do-Target-Url': 'https://jer.com.co/a' }), body: '' }, 'https://jer.com.co/a', () => ({ ok: true, classification: 'valid_results', value: 'result' }))).toMatchObject({ ok: false, classification: 'provider_error' });
  });

  it('preserves typed network and timeout provider failures without unsafe error properties', () => {
    for (const kind of ['network', 'timeout'] as const) {
      const error = new ScrapedoProviderError(kind);
      const result = classifyScrapedoFailure<string>(error);
      expect(result).toMatchObject({ ok: false, classification: 'provider_error', error });
      expect(result.ok ? undefined : result.error).toBe(error);
      expect(error).toMatchObject({ kind, code: 'SCRAPEDO_PROVIDER_ERROR' });
      expect(error).not.toHaveProperty('url');
      expect(error).not.toHaveProperty('token');
    }
  });

  it('maps exact auth throttle body and redacts provider API credentials and URL', () => {
    const classified = classifyScrapedoResponse({ status: 200, headers: new Headers(), body: 'Your request has been temporarily throttled by the authentication server.' }, 'https://jer.com.co/a', () => ({ ok: true, classification: 'valid_results', value: 'result' }));
    const error = new ScrapedoProviderError();
    expect(classified).toMatchObject({ ok: false, classification: 'provider_error' });
    expect(String(error)).not.toContain('secret-token');
    expect(String(error)).not.toContain('api.scrape.do');
  });

  it('retries one provider concurrency response after injected delay with the same session and tier, then commits exactly once', async () => {
    const attempt = vi.fn<(_: SessionAttempt, __?: AbortSignal) => Promise<JerOperation<string>>>()
      .mockResolvedValueOnce(operation('concurrency_error'))
      .mockResolvedValueOnce({ ok: true, classification: 'valid_results', value: 'result' });
    const sleep = vi.fn(async () => undefined);
    const save = vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState }));
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'token-5' });
    const policy = { execute: vi.fn(async (previous: ProviderStateV1, request: (item: SessionAttempt) => Promise<SessionAttemptOutcome>) => {
      const session: SessionAttempt = { sessionId: previous.sessionId!, tier: 'STANDARD', transportOptions: { super: false } };
      const outcome = await request(session);
      return { state: previous, attempts: [session], outcome: outcome.kind };
    }) };
    const runtime = new ScrapedoRuntime({ policy, committer, attemptFactory: session => signal => attempt(session, signal), retryDelayMs: 25, sleep });
    runtime.bind(snapshot);

    await expect(runtime.execute(progress)).resolves.toEqual({ ok: true, classification: 'valid_results', value: 'result' });
    expect(sleep).toHaveBeenCalledWith(25, undefined);
    expect(attempt.mock.calls.map(([item]) => [item.sessionId, item.tier])).toEqual([[7, 'STANDARD'], [7, 'STANDARD']]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('applies the configured normal request delay before a Scrape.do operation', async () => {
    const sleep = vi.fn(async () => undefined);
    const save = vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState }));
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'token-5' });
    const policy = { execute: vi.fn(async (previous: ProviderStateV1, request: (item: SessionAttempt) => Promise<SessionAttemptOutcome>) => ({ state: previous, attempts: [], outcome: (await request({ sessionId: previous.sessionId!, tier: 'STANDARD', transportOptions: { super: false } })).kind })) };
    const runtime = new ScrapedoRuntime({ policy, committer, attemptFactory: () => async () => ({ ok: true, classification: 'valid_results', value: 'result' }), retryDelayMs: 25, sleep });
    runtime.bind(snapshot);

    await expect(runtime.execute(progress)).resolves.toMatchObject({ ok: true, classification: 'valid_results' });
    await expect(runtime.execute(progress)).resolves.toMatchObject({ ok: true, classification: 'valid_results' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25, undefined);
  });

  it('cancels during the sole concurrency delay without a duplicate attempt or commit', async () => {
    const controller = new AbortController();
    const attempt = vi.fn<(_: SessionAttempt, __?: AbortSignal) => Promise<JerOperation<string>>>(async () => operation<string>('concurrency_error'));
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => { controller.abort(new Error('stop')); if (signal?.aborted) throw signal.reason; });
    const save = vi.fn();
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'token-5' });
    const policy = { execute: vi.fn(async (_previous: ProviderStateV1, request: (item: SessionAttempt) => Promise<SessionAttemptOutcome>) => ({ state, attempts: [], outcome: (await request({ sessionId: 7, tier: 'STANDARD', transportOptions: { super: false } })).kind })) };
    const runtime = new ScrapedoRuntime({ policy, committer, attemptFactory: session => signal => attempt(session, signal), retryDelayMs: 25, sleep });
    runtime.bind(snapshot);

    await expect(runtime.execute(progress, controller.signal)).resolves.toMatchObject({ ok: false, classification: 'cancelled' });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('makes exactly two same-session concurrency attempts with one sleep and no commit or rotation', async () => {
    const attempt = vi.fn<(_: SessionAttempt) => Promise<JerOperation<string>>>(async () => operation<string>('concurrency_error'));
    const sleep = vi.fn(async () => undefined);
    const save = vi.fn();
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'token-5' });
    const policy = { execute: vi.fn(async (previous: ProviderStateV1, request: (item: SessionAttempt) => Promise<SessionAttemptOutcome>) => {
      const session: SessionAttempt = { sessionId: previous.sessionId!, tier: 'STANDARD', transportOptions: { super: false } };
      const outcome = await request(session);
      return { state: previous, attempts: [session], outcome: outcome.kind };
    }) };
    const runtime = new ScrapedoRuntime({ policy, committer, attemptFactory: session => () => attempt(session), retryDelayMs: 25, sleep });
    runtime.bind(snapshot);

    await expect(runtime.execute(progress)).resolves.toMatchObject({ ok: false, classification: 'concurrency_error' });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.map(([item]) => [item.sessionId, item.tier])).toEqual([[7, 'STANDARD'], [7, 'STANDARD']]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(committer.current()).toEqual(snapshot);
  });

  it('owns binding snapshots exclusively and swaps only an exact accepted receipt', async () => {
    const save = vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState }));
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: () => 'token-5' });
    committer.bind(snapshot);
    expect(committer.current()).toEqual(snapshot);
    await expect(committer.commit(state, progress)).resolves.toMatchObject({ committed: { version: 5, requestToken: 'token-5' } });
    expect(() => committer.bind(snapshot)).toThrow('already bound');
  });

  it('samples the latest supplied business progress for every provider-state commit', async () => {
    const save = vi.fn(async write => ({ accepted: true, duplicate: false, runId: write.runId, version: write.version, requestToken: write.requestToken, providerState: write.providerState }));
    const committer = new ProviderStateCommitter({ save }, { nextRequestToken: vi.fn(() => 'token-5') });
    const policy = { execute: vi.fn(async (previous: ProviderStateV1, request: (item: SessionAttempt) => Promise<SessionAttemptOutcome>) => ({ state: previous, attempts: [], outcome: (await request({ sessionId: previous.sessionId!, tier: 'STANDARD', transportOptions: { super: false } })).kind })) };
    const current = { ...progress, attempted: 0, status: 'RUNNING', nextPendingDate: '2026-07-01' };
    const runtime = new ScrapedoRuntime({ policy, committer, attemptFactory: () => async () => ({ ok: true, classification: 'valid_results', value: 'result' }), retryDelayMs: 5, sleep: vi.fn() });
    runtime.bind(snapshot);

    await runtime.executeFrom(() => current);
    current.attempted = 2;
    current.status = 'PAUSED';
    current.nextPendingDate = '2026-07-02';
    await runtime.executeFrom(() => current);

    expect(save.mock.calls.map(([write]) => ({ attempted: write.attempted, status: write.status, nextPendingDate: write.nextPendingDate, version: write.version, requestToken: write.requestToken, providerState: write.providerState }))).toEqual([
      { attempted: 0, status: 'RUNNING', nextPendingDate: '2026-07-01', version: 5, requestToken: 'token-5', providerState: state },
      { attempted: 2, status: 'PAUSED', nextPendingDate: '2026-07-02', version: 6, requestToken: 'token-5', providerState: state },
    ]);
  });

  it.each([
    ['runId', { accepted: true, duplicate: false, runId: 'other-run', version: 5, requestToken: 'token-5', providerState: state }],
    ['version', { accepted: true, duplicate: false, runId: 'run', version: 6, requestToken: 'token-5', providerState: state }],
    ['requestToken', { accepted: true, duplicate: false, runId: 'run', version: 5, requestToken: 'other-token', providerState: state }],
    ['providerState', { accepted: true, duplicate: false, runId: 'run', version: 5, requestToken: 'token-5', providerState: { ...state, sessionId: 8 } }],
  ] as const)('keeps the prior snapshot when receipt %s mismatches', async (_field, receipt) => {
    const committer = new ProviderStateCommitter({ save: vi.fn(async () => receipt) }, { nextRequestToken: () => 'token-5' });
    committer.bind(snapshot);
    await expect(committer.commit(state, progress)).rejects.toThrow('invalid provider-state receipt');
    expect(committer.current()).toEqual(snapshot);
  });

  it.each([
    ['accepted:false', { accepted: false, duplicate: false, runId: 'run', version: 5, requestToken: 'token-5', providerState: state }],
    ['duplicate:true', { accepted: true, duplicate: true, runId: 'run', version: 5, requestToken: 'token-5', providerState: state }],
    ['malformed missing requestToken', { accepted: true, duplicate: false, runId: 'run', version: 5, providerState: state }],
  ] as const)('rejects %s receipts without mutating the original bound snapshot', async (_case, receipt) => {
    const original = structuredClone(snapshot);
    const committer = new ProviderStateCommitter({ save: vi.fn(async () => receipt as never) }, { nextRequestToken: () => 'token-5' });
    committer.bind(snapshot);

    await expect(committer.commit(state, progress)).rejects.toThrow('invalid provider-state receipt');
    expect(committer.current()).toEqual(original);
    expect(committer.current().committed).toEqual(original.committed);
  });

  it('keeps the prior snapshot when its RPC throws', async () => {
    const committer = new ProviderStateCommitter({ save: vi.fn(async () => { throw new Error('rpc failed'); }) }, { nextRequestToken: () => 'token-5' });
    committer.bind(snapshot);
    await expect(committer.commit(state, progress)).rejects.toThrow('rpc failed');
    expect(committer.current()).toEqual(snapshot);
  });
});
