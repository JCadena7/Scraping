import { randomUUID } from 'node:crypto';
import { JerError } from './domain.js';
import type { ProviderStateV1, SessionAttempt, SessionAttemptOutcome } from './session-policy.js';

export type JerOperation<T> =
  | { ok: true; classification: 'valid_results'; value: T }
  | { ok: true; classification: 'valid_no_results'; value: null }
  | { ok: false; classification: 'verification_page' | 'blocked' | 'rate_limited' | 'concurrency_error' | 'provider_error' | 'unknown_html' | 'cancelled'; error: JerError };

export interface ScrapedoRawResponse { status: number; headers: Headers; body: string; }
export interface ScrapedoBindingSnapshot { runId: string; ownerToken: string; committed: { version: number; requestToken: string; providerState: ProviderStateV1 }; }
export type ProgressWriteWithoutVersionTokenProviderState = { attempted: number; inserted: number; updated: number; skipped: number; failed: number; status: string; nextPendingDate?: string; };
export type ProgressSupplier = () => ProgressWriteWithoutVersionTokenProviderState;
export interface ProviderStateReceipt { accepted: boolean; duplicate: boolean; runId: string; version: number; requestToken: string; providerState: ProviderStateV1; }
export interface ProviderStateWriter { save(write: ProgressWriteWithoutVersionTokenProviderState & { runId: string; ownerToken: string; version: number; requestToken: string; providerState: ProviderStateV1 }): Promise<ProviderStateReceipt>; }
export interface ProviderStateCommitter { bind(snapshot: ScrapedoBindingSnapshot): void; current(): Readonly<ScrapedoBindingSnapshot>; commit(candidateState: ProviderStateV1, progress: ProgressWriteWithoutVersionTokenProviderState): Promise<Readonly<ScrapedoBindingSnapshot>>; }
export type ScrapedoAttemptFactory<T> = (attempt: SessionAttempt) => (signal?: AbortSignal) => Promise<JerOperation<T>>;
export type ScrapedoPolicy = { execute(previous: ProviderStateV1 | undefined, request: (attempt: SessionAttempt) => Promise<SessionAttemptOutcome>): Promise<{ state: ProviderStateV1; attempts: SessionAttempt[]; outcome: string }>; };

export class ScrapedoProviderError extends JerError {
  constructor(public readonly kind: 'network' | 'timeout' | 'provider' = 'provider') { super(kind === 'timeout' ? 'Request timeout' : 'Scrape.do request failed', 'SCRAPEDO_PROVIDER_ERROR'); this.name = 'ScrapedoProviderError'; }
}

export class ProviderStateCommitter implements ProviderStateCommitter {
  private snapshot?: ScrapedoBindingSnapshot;
  private readonly nextRequestToken: () => string;

  constructor(private readonly writer: ProviderStateWriter, options: { nextRequestToken?: () => string } = {}) { this.nextRequestToken = options.nextRequestToken ?? randomUUID; }

  bind(snapshot: ScrapedoBindingSnapshot): void {
    if (this.snapshot) throw new Error('Provider state committer is already bound');
    this.snapshot = snapshot;
  }

  current(): Readonly<ScrapedoBindingSnapshot> {
    if (!this.snapshot) throw new Error('Provider state committer is not bound');
    return this.snapshot;
  }

  async commit(candidateState: ProviderStateV1, progress: ProgressWriteWithoutVersionTokenProviderState): Promise<Readonly<ScrapedoBindingSnapshot>> {
    const current = this.current();
    const committed = { version: current.committed.version + 1, requestToken: this.nextRequestToken(), providerState: candidateState };
    const receipt = await this.writer.save({ ...progress, runId: current.runId, ownerToken: current.ownerToken, ...committed });
    if (!receipt.accepted || receipt.duplicate || receipt.runId !== current.runId || receipt.version !== committed.version || receipt.requestToken !== committed.requestToken || !sameState(receipt.providerState, committed.providerState)) throw new Error('invalid provider-state receipt');
    this.snapshot = { ...current, committed };
    return this.snapshot;
  }
}

export interface ScrapedoRuntimeOptions<T> { policy: ScrapedoPolicy; committer: ProviderStateCommitter; attemptFactory?: ScrapedoAttemptFactory<T>; retryDelayMs: number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }

export class ScrapedoRuntime<T> {
  private hasExecuted = false;
  constructor(private readonly options: ScrapedoRuntimeOptions<T>) {}
  bind(snapshot: ScrapedoBindingSnapshot): void { this.options.committer.bind(snapshot); }

  canRetryBlockedRequest(): boolean {
    try {
      const state = this.options.committer.current().committed.providerState;
      return state.sessionStatus === 'INVALID' && !state.pendingSuper;
    } catch { return false; }
  }

  async executeFrom(progress: ProgressSupplier, signal?: AbortSignal, attemptFactory = this.options.attemptFactory): Promise<JerOperation<T>> {
    return this.executeInternal(progress, signal, attemptFactory);
  }

  async saveProgress(progress: ProgressWriteWithoutVersionTokenProviderState): Promise<Readonly<ScrapedoBindingSnapshot>> {
    return this.options.committer.commit(this.options.committer.current().committed.providerState, progress);
  }

  async execute(progress: ProgressWriteWithoutVersionTokenProviderState, signal?: AbortSignal, attemptFactory = this.options.attemptFactory): Promise<JerOperation<T>> {
    return this.executeInternal(() => progress, signal, attemptFactory);
  }

  private async executeInternal(progress: ProgressSupplier, signal?: AbortSignal, attemptFactory = this.options.attemptFactory): Promise<JerOperation<T>> {
    let snapshot: Readonly<ScrapedoBindingSnapshot>;
    try { snapshot = this.options.committer.current(); }
    catch { return failure('provider_error'); }
    if (this.hasExecuted && this.options.retryDelayMs) {
      try { await this.options.sleep(this.options.retryDelayMs, signal); }
      catch { return failure('cancelled'); }
      if (signal?.aborted) return failure('cancelled');
    }
    this.hasExecuted = true;
    let operation: JerOperation<T> = failure('provider_error');
    const result = await this.options.policy.execute(snapshot.committed.providerState, async attempt => {
      operation = attemptFactory ? await this.runAttempt(attempt, signal, attemptFactory) : failure('provider_error');
      return { kind: operationKind(operation) };
    });
    if (operation.classification === 'cancelled' || operation.classification === 'concurrency_error') return operation;
    try { await this.options.committer.commit(result.state, progress()); }
    catch { return failure('provider_error'); }
    return operation;
  }

  private async runAttempt(attempt: SessionAttempt, signal: AbortSignal | undefined, attemptFactory: ScrapedoAttemptFactory<T>): Promise<JerOperation<T>> {
    if (signal?.aborted) return failure('cancelled');
    let operation = await attemptFactory(attempt)(signal);
    if (operation.classification !== 'concurrency_error') return operation;
    try { await this.options.sleep(this.options.retryDelayMs, signal); }
    catch { return failure('cancelled'); }
    if (signal?.aborted) return failure('cancelled');
    operation = await attemptFactory(attempt)(signal);
    return operation;
  }
}

export function classifyScrapedoResponse<T>(response: ScrapedoRawResponse, requestUrl: string, classifyBody: (body: string) => JerOperation<T>): JerOperation<T> {
  if (trustedTargetStatus(response, requestUrl, 403)) return failure('blocked');
  if (trustedTargetStatus(response, requestUrl, 429)) return failure('rate_limited');
  if (response.status === 429) return failure('concurrency_error');
  if (response.status === 401 || response.status === 502 || response.status === 510 || response.status === 400 || response.body === 'Your request has been temporarily throttled by the authentication server.') return failure('provider_error');
  if (response.status < 200 || response.status >= 300) return failure('provider_error');
  return classifyBody(response.body);
}
export function classifyScrapedoFailure<T>(error: unknown, signal?: AbortSignal): JerOperation<T> {
  return signal?.aborted ? failure('cancelled') : failure('provider_error', error instanceof ScrapedoProviderError ? error : undefined);
}

function trustedTargetStatus(response: ScrapedoRawResponse, requestUrl: string, status: number): boolean {
  if (response.status !== status || parseInitialStatus(response.headers.get('Scrape.do-Initial-Status-Code')) !== status) return false;
  try { return new URL(response.headers.get('Scrape.do-Target-Url') ?? '').href === new URL(requestUrl).href; }
  catch { return false; }
}
function operationKind<T>(operation: JerOperation<T>): SessionAttemptOutcome['kind'] {
  return operation.classification === 'cancelled' ? 'cancellation' : operation.classification;
}
function parseInitialStatus(value: string | null): number | undefined {
  if (!value || !/^(?:[1-5]\d\d)$/.test(value)) return undefined;
  const status = Number(value);
  return Number.isSafeInteger(status) ? status : undefined;
}
function failure<T>(classification: Extract<JerOperation<T>, { ok: false }>['classification'], error: JerError = new ScrapedoProviderError()): JerOperation<T> { return { ok: false, classification, error }; }
function sameState(left: ProviderStateV1, right: ProviderStateV1): boolean { return JSON.stringify(left) === JSON.stringify(right); }
