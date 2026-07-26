import { JerBlockedError, JerRateLimitError, type IngestionStatus, type SourceState } from './domain.js';

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export interface SourceGateResult { state: SourceState; blockedUntil?: number; }
export interface SourceGate { ensureActive(at?: number): Promise<SourceGateResult>; }
export interface ProgressCounters { attempted: number; inserted: number; }
export interface ProgressWrite { ownerToken: string; version: number; absoluteCounters: ProgressCounters; status: IngestionStatus; }
export interface ProgressSaveResult { accepted: boolean; duplicate: boolean; }
export interface LeaseHeartbeatContract { leaseDurationMs: number; renewIntervalMs: number; }
export interface RenewableLeaseHeartbeatOptions { ownerToken: string; renew: (ownerToken: string) => Promise<boolean>; controller: AbortController; clock: Clock; onFatal: (error: Error) => void; leaseDurationMs?: number; renewIntervalMs?: number; }
export interface OwnerFinalizerOptions { controller: AbortController; heartbeat: { stop(): void }; persistCancelled: () => Promise<void>; release: () => Promise<void>; }

export async function executeGuarded<T>(gate: SourceGate, operation: () => Promise<T>, clock?: Pick<Clock, 'now'>): Promise<T> {
  const result = await gate.ensureActive(clock?.now());
  if (result.state !== 'ACTIVE') throw new Error(`Source is ${result.state}`);
  return operation();
}

export function toOperationalOutcome(error: unknown): { sourceState: SourceState; runStatus: IngestionStatus; exitCode: number; retryAfterMs?: number } | undefined {
  if (error instanceof JerBlockedError) return { sourceState: 'BLOCKED', runStatus: 'BLOCKED', exitCode: 3 };
  if (error instanceof JerRateLimitError) return { sourceState: 'RATE_LIMITED', runStatus: 'PAUSED', exitCode: 4, retryAfterMs: error.retryAfterMs };
  return undefined;
}

export class RenewableLeaseHeartbeat {
  readonly contract: LeaseHeartbeatContract;
  private running = false;
  private task?: Promise<void>;

  constructor(private readonly options: RenewableLeaseHeartbeatOptions) {
    this.contract = { leaseDurationMs: options.leaseDurationMs ?? 60000, renewIntervalMs: options.renewIntervalMs ?? 20000 };
    if (this.contract.renewIntervalMs >= this.contract.leaseDurationMs) throw new Error('Lease renew interval must be less than lease duration');
  }

  start(): void { if (!this.running) { this.running = true; this.task = this.run(); } }
  stop(): void { this.running = false; }
  async settled(): Promise<void> { await this.task; }

  private async run(): Promise<void> {
    while (this.running && !this.options.controller.signal.aborted) {
      try {
        await this.options.clock.sleep(this.contract.renewIntervalMs, this.options.controller.signal);
        if (!this.running || this.options.controller.signal.aborted) return;
        if (!await this.options.renew(this.options.ownerToken)) throw new Error('Lease renewal was rejected');
      } catch (error) {
        if (this.options.controller.signal.aborted) return;
        const fatal = error instanceof Error ? error : new Error(String(error));
        this.options.controller.abort(fatal);
        this.options.onFatal(fatal);
        return;
      }
    }
  }
}

export class OwnerFinalizer {
  private terminal?: Promise<number>;
  constructor(private readonly options: OwnerFinalizerOptions) {}

  cancel(reason: Error): Promise<number> {
    if (!this.terminal) this.terminal = this.finalize(reason);
    return this.terminal;
  }

  complete(exitCode: number): Promise<number> {
    if (this.options.controller.signal.aborted) return this.cancel(this.options.controller.signal.reason instanceof Error ? this.options.controller.signal.reason : new Error('Aborted'));
    if (!this.terminal) this.terminal = this.finalizeCompletion(exitCode);
    return this.terminal;
  }

  private async finalize(reason: Error): Promise<number> {
    if (!this.options.controller.signal.aborted) this.options.controller.abort(reason);
    this.options.heartbeat.stop();
    try { await this.options.persistCancelled(); } catch { /* cancellation keeps its terminal exit contract */ }
    finally { await this.options.release(); }
    return 130;
  }

  private async finalizeCompletion(exitCode: number): Promise<number> {
    this.options.heartbeat.stop();
    await this.options.release();
    return exitCode;
  }
}

export class InMemoryProgressStore {
  snapshot?: ProgressWrite;

  save(write: ProgressWrite): ProgressSaveResult {
    if (!this.snapshot) { this.snapshot = structuredClone(write); return { accepted: true, duplicate: false }; }
    if (write.ownerToken !== this.snapshot.ownerToken) throw new Error('Stale progress owner');
    if (write.version < this.snapshot.version) throw new Error('Stale progress version');
    if (write.version === this.snapshot.version) {
      if (JSON.stringify(write) === JSON.stringify(this.snapshot)) return { accepted: true, duplicate: true };
      throw new Error('Conflicting progress version');
    }
    this.snapshot = structuredClone(write);
    return { accepted: true, duplicate: false };
  }
}
