import { describe, expect, it } from 'vitest';
import {
  SecureSessionIdGenerator,
  type ProviderStateV1,
  ScrapedoSessionPolicy,
  type SessionIdGenerator,
} from '../src/jer/session-policy.js';

class SequenceGenerator implements SessionIdGenerator {
  constructor(private readonly values: number[]) {}

  next(excluded: ReadonlySet<number> = new Set()): number {
    const value = this.values.shift();
    if (value === undefined) throw new Error('fake exhausted');
    if (excluded.has(value)) throw new Error(`fake supplied excluded session ${value}`);
    return value;
  }
}

const standard = (sessionId = 10): ProviderStateV1 => ({
  schemaVersion: 1,
  provider: 'SCRAPEDO',
  targetOrigin: 'https://jer.com.co',
  tier: 'STANDARD',
  sessionId,
  sessionStatus: 'ACTIVE',
  standardBlockedSessionCount: 0,
  pendingSuper: false,
});

describe('Scrape.do session ID generation', () => {
  it('uses inclusive lower and upper bounds from an injectable secure random source', () => {
    const lower = new SecureSessionIdGenerator(() => 0);
    const upper = new SecureSessionIdGenerator(() => 1_000_000);

    expect(lower.next()).toBe(0);
    expect(upper.next()).toBe(1_000_000);
  });

  it('regenerates excluded IDs and fails after a finite number of defective repeats', () => {
    const generator = new SecureSessionIdGenerator(
      (() => { const values = [4, 8]; return () => values.shift() ?? 4; })(),
      2,
    );
    const defective = new SecureSessionIdGenerator(() => 4, 2);

    expect(generator.next(new Set([4]))).toBe(8);
    expect(() => defective.next(new Set([4]))).toThrow('Unable to generate a non-excluded session ID');
  });
});

describe('Scrape.do sticky-session policy', () => {
  it('reuses an active session across valid logical requests and resets the STANDARD blocked count', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([99]), maxStandardBlockedSessions: 2, superEnabled: true });
    const blocked = { ...standard(7), standardBlockedSessionCount: 1 };
    let now = 0;
    const clock = () => now;
    const seen: Array<{ sessionId: number; tier: 'STANDARD' | 'SUPER'; at: number; transportOptions: { super: boolean } }> = [];

    const first = await policy.execute(blocked, async session => {
      seen.push({ ...session, at: clock() });
      return { kind: 'valid_results' as const };
    });
    now += 5 * 60_000 + 1;
    const second = await policy.execute(first.state, async session => {
      seen.push({ ...session, at: clock() });
      return { kind: 'valid_no_results' as const };
    });

    expect(first.attempts.map(item => item.sessionId)).toEqual([7]);
    expect(first.state).toMatchObject({ sessionId: 7, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0 });
    expect(second.attempts.map(item => item.sessionId)).toEqual([7]);
    expect(seen).toEqual([
      { sessionId: 7, tier: 'STANDARD', transportOptions: { super: false }, at: 0 },
      { sessionId: 7, tier: 'STANDARD', transportOptions: { super: false }, at: 5 * 60_000 + 1 },
    ]);
  });

  it('persists an invalid Standard session after a confirmed block and rotates only on the next logical request', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11]), maxStandardBlockedSessions: 3, superEnabled: true });
    const outcomes = [{ kind: 'blocked' as const }];

    const result = await policy.execute(standard(10), async () => outcomes.shift()!);

    expect(result.attempts).toEqual([{ sessionId: 10, tier: 'STANDARD', transportOptions: { super: false } }]);
    expect(result.state).toMatchObject({ sessionId: 10, sessionStatus: 'INVALID', standardBlockedSessionCount: 1, pendingSuper: false });
  });

  it('does not make a same-request replacement after a verification page', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11, 12]), maxStandardBlockedSessions: 3, superEnabled: true });
    const outcomes = [{ kind: 'verification_page' as const }];

    const result = await policy.execute(standard(10), async () => outcomes.shift()!);

    expect(result.attempts.map(item => item.sessionId)).toEqual([10]);
    expect(result.state).toMatchObject({ sessionId: 10, sessionStatus: 'INVALID', standardBlockedSessionCount: 1 });
    expect(result.outcome).toBe('verification_page');
  });

  it.each([
    'valid_results', 'valid_no_results', 'rate_limited', 'provider_error', 'concurrency_error', 'auth_error',
    'credits_error', 'provider_502', 'network_error', 'timeout', 'unknown_html', 'persistence_error',
    'lease_error', 'parse_error', 'data_error',
  ] as const)('does not rotate for %s', async kind => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11]), maxStandardBlockedSessions: 2, superEnabled: true });

    const result = await policy.execute(standard(10), async () => ({ kind }));

    expect(result.attempts.map(item => item.sessionId)).toEqual([10]);
    expect(result.state.sessionId).toBe(10);
    expect(result.state.sessionStatus).toBe('ACTIVE');
  });

  it('does not rotate for SIGINT cancellation', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11]), maxStandardBlockedSessions: 2, superEnabled: true });

    const result = await policy.execute(standard(10), async () => ({ kind: 'cancellation' as const }));

    expect(result.attempts.map(item => item.sessionId)).toEqual([10]);
    expect(result.state).toMatchObject({ sessionId: 10, sessionStatus: 'ACTIVE' });
  });

  it('does not rotate for SIGTERM cancellation', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11]), maxStandardBlockedSessions: 2, superEnabled: true });

    const result = await policy.execute(standard(10), async () => ({ kind: 'cancellation' as const }));

    expect(result.attempts.map(item => item.sessionId)).toEqual([10]);
    expect(result.state).toMatchObject({ sessionId: 10, sessionStatus: 'ACTIVE' });
  });

  it('replaces a prior invalid non-pending STANDARD session before the next logical request', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11]), maxStandardBlockedSessions: 3, superEnabled: true });
    const invalid = { ...standard(10), sessionStatus: 'INVALID' as const, standardBlockedSessionCount: 1 };

    const result = await policy.execute(invalid, async () => ({ kind: 'valid_results' as const }));

    expect(result.attempts).toEqual([{ sessionId: 11, tier: 'STANDARD', transportOptions: { super: false } }]);
    expect(result.state).toMatchObject({ sessionId: 11, sessionStatus: 'ACTIVE', standardBlockedSessionCount: 0, pendingSuper: false });
  });

  it('counts each invalidated STANDARD session, persists pending Super at the threshold, and delays promotion', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([11, 12]), maxStandardBlockedSessions: 2, superEnabled: true });
    const outcomes = [{ kind: 'blocked' as const }];

    const result = await policy.execute(standard(10), async () => outcomes.shift()!);

    expect(result.state).toMatchObject({ tier: 'STANDARD', sessionId: 10, sessionStatus: 'INVALID', standardBlockedSessionCount: 1, pendingSuper: false });
    expect(result.attempts.map(item => item.tier)).toEqual(['STANDARD']);
  });

  it('promotes only the next permitted request to a sticky SUPER session and keeps Super success active', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([20]), maxStandardBlockedSessions: 2, superEnabled: true });
    const pending = { ...standard(10), sessionStatus: 'INVALID' as const, standardBlockedSessionCount: 2, pendingSuper: true };

    const result = await policy.execute(pending, async () => ({ kind: 'valid_results' as const }));

    expect(result.attempts).toEqual([{ sessionId: 20, tier: 'SUPER', transportOptions: { super: true } }]);
    expect(result.state).toMatchObject({ tier: 'SUPER', sessionId: 20, sessionStatus: 'ACTIVE', pendingSuper: false });
  });

  it('does not promote pending Super when disabled and never downgrades an active Super session', async () => {
    const disabled = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([20]), maxStandardBlockedSessions: 2, superEnabled: false });
    const pending = { ...standard(10), sessionStatus: 'INVALID' as const, standardBlockedSessionCount: 2, pendingSuper: true };
    const activeSuper = { ...standard(20), tier: 'SUPER' as const, standardBlockedSessionCount: 2 };

    const terminal = await disabled.execute(pending, async () => ({ kind: 'valid_results' as const }));
    const continued = await disabled.execute(activeSuper, async () => ({ kind: 'valid_no_results' as const }));

    expect(terminal.attempts).toEqual([]);
    expect(terminal.outcome).toBe('pending_super_disabled');
    expect(continued.state).toMatchObject({ tier: 'SUPER', sessionId: 20, sessionStatus: 'ACTIVE' });
  });

  it('leaves a blocked Super invalid for one next-request rotation', async () => {
    const policy = new ScrapedoSessionPolicy({ generator: new SequenceGenerator([21, 22]), maxStandardBlockedSessions: 2, superEnabled: true });
    const activeSuper = { ...standard(20), tier: 'SUPER' as const, standardBlockedSessionCount: 2 };
    const outcomes = [{ kind: 'blocked' as const }];

    const result = await policy.execute(activeSuper, async () => outcomes.shift()!);

    expect(result.attempts).toEqual([{ sessionId: 20, tier: 'SUPER', transportOptions: { super: true } }]);
    expect(result.state).toMatchObject({ tier: 'SUPER', sessionId: 20, sessionStatus: 'INVALID', standardBlockedSessionCount: 2 });
  });
});
