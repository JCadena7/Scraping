import { randomInt } from 'node:crypto';

export const SESSION_ID_MIN = 0;
export const SESSION_ID_MAX = 1_000_000;

export type SessionTier = 'STANDARD' | 'SUPER';
export type SessionStatus = 'ACTIVE' | 'INVALID';

export interface SessionIdGenerator {
  next(excluded?: ReadonlySet<number>): number;
}

type RandomInt = (minimum: number, maximumExclusive: number) => number;

export class SecureSessionIdGenerator implements SessionIdGenerator {
  constructor(private readonly randomIntImpl: RandomInt = randomInt, private readonly maxAttempts?: number) {}

  next(excluded: ReadonlySet<number> = new Set()): number {
    const attempts = this.maxAttempts ?? excluded.size + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = this.randomIntImpl(SESSION_ID_MIN, SESSION_ID_MAX + 1);
      if (Number.isInteger(value) && value >= SESSION_ID_MIN && value <= SESSION_ID_MAX && !excluded.has(value)) return value;
    }
    throw new Error('Unable to generate a non-excluded session ID');
  }
}

export interface ProviderStateV1 {
  schemaVersion: 1;
  provider: 'SCRAPEDO';
  targetOrigin: string;
  tier: SessionTier;
  sessionId: number | null;
  sessionStatus: SessionStatus;
  standardBlockedSessionCount: number;
  pendingSuper: boolean;
}

export type SessionAttemptKind =
  | 'valid_results'
  | 'valid_no_results'
  | 'blocked'
  | 'verification_page'
  | 'rate_limited'
  | 'provider_error'
  | 'concurrency_error'
  | 'auth_error'
  | 'credits_error'
  | 'provider_502'
  | 'network_error'
  | 'timeout'
  | 'unknown_html'
  | 'persistence_error'
  | 'lease_error'
  | 'cancellation'
  | 'parse_error'
  | 'data_error';

export interface SessionAttemptOutcome { kind: SessionAttemptKind; }
interface StandardSessionAttempt {
  sessionId: number;
  tier: 'STANDARD';
  transportOptions: { super: false };
}
interface SuperSessionAttempt {
  sessionId: number;
  tier: 'SUPER';
  transportOptions: { super: true };
}
export type SessionAttempt = StandardSessionAttempt | SuperSessionAttempt;
export interface ScrapedoSessionPolicyOptions {
  generator: SessionIdGenerator;
  maxStandardBlockedSessions: number;
  superEnabled: boolean;
  targetOrigin?: string;
  maxRetries?: 1;
}
export interface SessionPolicyResult {
  state: ProviderStateV1;
  attempts: SessionAttempt[];
  outcome: SessionAttemptKind | 'pending_super_disabled';
}

export class ScrapedoSessionPolicy {
  constructor(private readonly options: ScrapedoSessionPolicyOptions) {}

  async execute(
    previous: ProviderStateV1 | undefined,
    request: (session: SessionAttempt) => Promise<SessionAttemptOutcome>,
  ): Promise<SessionPolicyResult> {
    let state = previous ?? this.newState('STANDARD');
    if (state.pendingSuper) {
      if (!this.options.superEnabled) return { state, attempts: [], outcome: 'pending_super_disabled' };
      state = this.newState('SUPER');
    } else if (state.sessionId === null || state.sessionStatus === 'INVALID') {
      state = this.replace(state);
    }

    const attempts: SessionAttempt[] = [];
    const first = await this.request(state, request, attempts);
    if (!isBlocking(first.kind)) return { state: this.afterNonBlocking(state, first.kind), attempts, outcome: first.kind };
    return { state: this.invalidate(state), attempts, outcome: first.kind };
  }

  private newState(tier: SessionTier): ProviderStateV1 {
    return {
      schemaVersion: 1,
      provider: 'SCRAPEDO',
      targetOrigin: this.options.targetOrigin ?? 'https://jer.com.co',
      tier,
      sessionId: this.options.generator.next(),
      sessionStatus: 'ACTIVE',
      standardBlockedSessionCount: 0,
      pendingSuper: false,
    };
  }

  private async request(state: ProviderStateV1, request: (session: SessionAttempt) => Promise<SessionAttemptOutcome>, attempts: SessionAttempt[]): Promise<SessionAttemptOutcome> {
    if (state.sessionId === null) throw new Error('Scrape.do session state has no active session');
    const session: SessionAttempt = state.tier === 'SUPER'
      ? { sessionId: state.sessionId, tier: 'SUPER', transportOptions: { super: true } }
      : { sessionId: state.sessionId, tier: 'STANDARD', transportOptions: { super: false } };
    attempts.push(session);
    return request(session);
  }

  private invalidate(state: ProviderStateV1): ProviderStateV1 {
    if (state.tier === 'SUPER') return { ...state, sessionStatus: 'INVALID' };
    const standardBlockedSessionCount = state.standardBlockedSessionCount + 1;
    return {
      ...state,
      sessionStatus: 'INVALID',
      standardBlockedSessionCount,
      pendingSuper: standardBlockedSessionCount >= this.options.maxStandardBlockedSessions,
    };
  }

  private replace(invalidated: ProviderStateV1): ProviderStateV1 {
    return {
      ...invalidated,
      sessionId: this.options.generator.next(invalidated.sessionId === null ? new Set() : new Set([invalidated.sessionId])),
      sessionStatus: 'ACTIVE',
    };
  }

  private afterNonBlocking(state: ProviderStateV1, kind: SessionAttemptKind): ProviderStateV1 {
    if (state.tier === 'STANDARD' && isValid(kind)) return { ...state, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false };
    return { ...state, sessionStatus: 'ACTIVE' };
  }
}

function isBlocking(kind: SessionAttemptKind): boolean {
  return kind === 'blocked' || kind === 'verification_page';
}

function isValid(kind: SessionAttemptKind): boolean {
  return kind === 'valid_results' || kind === 'valid_no_results';
}
