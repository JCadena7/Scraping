import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DrawRepository } from '../src/jer/repository.js';
import { canonicalResultHash } from '../src/jer/hash.js';
import { createSupabaseClient } from '../src/jer/supabase.js';
import type { ProviderStateV1 } from '../src/jer/session-policy.js';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ mocked: true })) }));

const result = {
  gameCode: 'CHANCE-1',
  gameName: 'Chance',
  gameType: 'CHANCE' as const,
  drawDate: '2026-07-24',
  drawNumber: '12',
  winningNumber: '0017',
  fifthDigit: '9',
  series: 'AB12',
  zodiacSign: null,
  sourceUrl: 'https://jer.example/results',
  sourceHash: 'v2:hash',
  fetchedAt: new Date('2026-07-24T00:00:00.000Z'),
  verified: true,
};

function clientWithStoredDrawNumber(drawNumber?: string) {
  const gameQuery = { maybeSingle: vi.fn(async () => ({ data: { id: 'game-id', external_code: 'CHANCE-1', name: 'Chance', type: 'CHANCE', detail_url: result.sourceUrl, active: true }, error: null })) };
  const resultQuery = { maybeSingle: vi.fn(async () => ({ data: drawNumber ? { draw_number: drawNumber } : null, error: null })) };
  for (const query of [gameQuery, resultQuery]) {
    Object.assign(query, { select: vi.fn(() => query), eq: vi.fn(() => query) });
  }
  return { from: vi.fn((table: string) => table === 'draw_games' ? gameQuery : resultQuery) };
}

describe('secure result persistence', () => {
  it('maps every operational RPC from its PostgREST one-row array response', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ acquired: true, state: 'ACTIVE', cooldown_until: null, lease_expires_at: null, version: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ renewed: true }], error: null })
      .mockResolvedValueOnce({ data: [{ released: true }], error: null })
      .mockResolvedValueOnce({ data: [{ accepted: true, duplicate: false, version: 2 }], error: null })
      .mockResolvedValueOnce({ data: [{ transitioned: true, blocked_until: '2026-07-25T00:00:00.000Z' }], error: null })
      .mockResolvedValueOnce({ data: [{ transitioned: true, cooldown_until: '2026-07-25T00:00:00.000Z' }], error: null });
    const repository = new DrawRepository({ rpc } as never);
    const owner = '00000000-0000-0000-0000-000000000001';
    await expect(repository.acquireJerLease(owner, 60000)).resolves.toMatchObject({ acquired: true });
    await expect(repository.renewJerLease(owner, 60000)).resolves.toBe(true);
    await expect(repository.releaseJerLease(owner)).resolves.toBe(true);
    await expect(repository.saveJerProgress('run', { ownerToken: owner, version: 2, requestToken: owner, attempted: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, status: 'RUNNING' })).resolves.toMatchObject({ accepted: true });
    await expect(repository.transitionJer403(owner, 'run', 21_600_000, 'forbidden')).resolves.toBe(true);
    await expect(repository.transitionJer429(owner, 'run', 3_600_000, 'limited')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('jer_renew_lease', { p_owner_token: owner, p_lease_duration_ms: 60000 });
    expect(rpc).toHaveBeenCalledWith('jer_release_lease', { p_owner_token: owner });
  });
  it('maps singleton RPC row arrays and rejects malformed acquire responses', async () => {
    const rpc = vi.fn(async () => ({ data: [{ acquired: true, state: 'ACTIVE', owner_token: '00000000-0000-0000-0000-000000000001', lease_expires_at: '2026-07-24T00:01:00.000Z', version: 1 }], error: null }));
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.acquireJerLease('00000000-0000-0000-0000-000000000001', 60000)).resolves.toMatchObject({ acquired: true, state: 'ACTIVE' });
    await expect(repository.acquireJerLease('00000000-0000-0000-0000-000000000001', 60000)).resolves.not.toBeInstanceOf(Array);
  });

  it.each([
    ['inserted', 'inserted'],
    ['skipped', 'skipped'],
    ['rebaselined', 'skipped'],
    ['updated', 'updated'],
  ] as const)('maps RPC action %s to public result %s', async (rpcAction, expected) => {
    const rpc = vi.fn(async () => ({ data: [{ action: rpcAction }], error: null }));
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.upsertResult(result)).resolves.toBe(expected);
    expect(rpc).toHaveBeenCalledWith('upsert_draw_result', {
      p_game_code: 'CHANCE-1',
      p_draw_date: '2026-07-24',
      p_draw_number: '12',
      p_winning_number: '0017',
      p_fifth_digit: '9',
      p_series: 'AB12',
      p_zodiac_sign: null,
      p_source_url: 'https://jer.example/results',
      p_source_hash: 'v2:hash',
      p_fetched_at: '2026-07-24T00:00:00.000Z',
      p_verified: true,
    });
  });

  it('surfaces RPC errors without attempting a client-side persistence sequence', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied' } }));
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.upsertResult(result)).rejects.toThrow('Could not persist result CHANCE-1/2026-07-24: permission denied');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('enriches a missing latest draw number before hashing so an unchanged historical result skips', async () => {
    const rpc = vi.fn(async () => ({ data: [{ action: 'skipped' }], error: null }));
    const repository = new DrawRepository({ ...clientWithStoredDrawNumber('12'), rpc } as never);
    const latest = { ...result, drawNumber: null, sourceHash: canonicalResultHash({ ...result, drawNumber: null }) };

    await expect(repository.upsertResult(latest)).resolves.toBe('skipped');
    expect(rpc).toHaveBeenCalledWith('upsert_draw_result', expect.objectContaining({
      p_draw_number: '12',
      p_source_hash: canonicalResultHash({ ...result, drawNumber: '12' }),
    }));
  });

  it('requires a service-role key and never falls back to an anon key', () => {
    expect(() => createSupabaseClient({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' })).toThrow('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  });
});

describe('hardened persistence migration', () => {
  it('defines RLS, role revokes, and a service-role-only atomic RPC contract', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607240001_harden_jer_persistence.sql'), 'utf8');

    for (const table of ['draw_games', 'draw_results', 'draw_result_changes', 'draw_ingestion_runs']) {
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
      expect(migration).toMatch(new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`, 'i'));
    }
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = pg_catalog, public/i);
    expect(migration).toMatch(/revoke all on function public\.upsert_draw_result[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.upsert_draw_result[\s\S]*to service_role/i);
    expect(migration).toMatch(/insert into public\.draw_results[\s\S]*on conflict \(game_id, draw_date\) do nothing/i);
    expect(migration).toMatch(/select[\s\S]*for update/i);
    expect(migration).toMatch(/not like 'v2:%'/i);
    expect(migration).toMatch(/insert into public\.draw_result_changes/i);
    expect(migration).toMatch(/'rebaselined'/i);
    expect(migration).toMatch(/'updated'/i);
  });

  it('keeps result and audit mutations inside the definer RPC boundary', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607240001_harden_jer_persistence.sql'), 'utf8');

    for (const table of ['draw_results', 'draw_result_changes']) {
      expect(migration).toMatch(new RegExp(`revoke insert, update, delete on table public\\.${table} from service_role;`, 'i'));
    }
  });

  it('relies on PostgreSQL statement rollback instead of swallowing RPC errors', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607240001_harden_jer_persistence.sql'), 'utf8');

    expect(migration).not.toMatch(/\bexception\s+when\b/i);
    expect(migration).toMatch(/insert into public\.draw_result_changes[\s\S]*update public\.draw_results/i);
  });

  it('includes a concurrent null-draw-number guard in the canonical migration', () => {
    const correction = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607240001_harden_jer_persistence.sql'), 'utf8');

    expect(correction).toMatch(/create trigger preserve_jer_draw_number/i);
    expect(correction).toMatch(/new\.draw_number := old\.draw_number/i);
  });
});

describe('Scrape.do run persistence', () => {
  const owner = '00000000-0000-0000-0000-000000000001';
  const requestToken = '00000000-0000-0000-0000-000000000002';
  const providerState: ProviderStateV1 = {
    schemaVersion: 1,
    provider: 'SCRAPEDO',
    targetOrigin: 'https://jer.com.co',
    tier: 'STANDARD',
    sessionId: 7,
    sessionStatus: 'ACTIVE',
    standardBlockedSessionCount: 0,
    pendingSuper: false,
  };

  it('maps nullable start/resume state and saves validated provider state through additive RPCs', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ run_id: 'run', provider_state: null, version: 4, request_token: requestToken }], error: null })
      .mockResolvedValueOnce({ data: [{ accepted: true, duplicate: false, run_id: 'run', version: 5, request_token: requestToken, provider_state: providerState }], error: null });
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.startOrResumeScrapedoBackfill(owner)).resolves.toEqual({ runId: 'run', providerState: undefined, version: 4, requestToken });
    await expect(repository.saveJerProgressWithProviderState('run', {
      ownerToken: owner, version: 5, requestToken, attempted: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState,
    })).resolves.toEqual({ accepted: true, duplicate: false, runId: 'run', version: 5, requestToken, providerState });
    expect(rpc).toHaveBeenCalledWith('jer_start_or_resume_scrapedo_backfill', { p_owner_token: owner });
    expect(rpc).toHaveBeenCalledWith('jer_save_progress_with_provider_state', {
      p_run_id: 'run', p_owner_token: owner, p_version: 5, p_request_token: requestToken,
      p_status: 'RUNNING', p_attempted: 1, p_inserted: 1, p_updated: 0,
      p_skipped: 0, p_failed: 0, p_next_pending_date: null, p_provider_state: providerState,
    });
  });

  it('accepts only the canonical fresh no-session state returned by start/resume', async () => {
    const fresh: ProviderStateV1 = { ...providerState, sessionId: null, sessionStatus: 'INVALID', standardBlockedSessionCount: 0, pendingSuper: false };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ run_id: 'run', provider_state: fresh, version: 1, request_token: requestToken }], error: null })
      .mockResolvedValueOnce({ data: [{ run_id: 'run', provider_state: { ...fresh, sessionStatus: 'ACTIVE' }, version: 1, request_token: requestToken }], error: null });
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.startOrResumeScrapedoBackfill(owner)).resolves.toEqual({ runId: 'run', providerState: fresh, version: 1, requestToken });
    await expect(repository.startOrResumeScrapedoBackfill(owner)).rejects.toThrow('Could not start or resume Scrape.do backfill: invalid RPC response');
  });

  it.each([
    ['out-of-range session', { ...providerState, sessionId: 1_000_001 }],
    ['oversized session', { ...providerState, sessionId: Number.MAX_SAFE_INTEGER }],
    ['wrong origin', { ...providerState, targetOrigin: 'https://evil.example' }],
    ['secret field', { ...providerState, secret: 'must-not-persist' }],
    ['missing canonical key', Object.fromEntries(Object.entries(providerState).filter(([key]) => key !== 'pendingSuper'))],
    ['wrong counter type', { ...providerState, standardBlockedSessionCount: '0' }],
    ['wrong tier enum', { ...providerState, tier: 'OTHER' }],
    ['scalar', 1],
    ['null', null],
    ['array', [providerState]],
  ])('rejects %s provider state before issuing its RPC', async (_description, invalid) => {
    const rpc = vi.fn();
    const repository = new DrawRepository({ rpc } as never);
    await expect(repository.saveJerProgressWithProviderState('run', {
      ownerToken: owner, version: 5, requestToken, attempted: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState: invalid as ProviderStateV1,
    })).rejects.toThrow('Invalid Scrape.do provider state');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['stale progress owner', 'stale progress version or request token', 'conflicting duplicate progress request'])('surfaces the RPC guard for %s without a fallback write', async (message) => {
    const rpc = vi.fn(async () => ({ data: null, error: { message } }));
    const repository = new DrawRepository({ rpc } as never);

    await expect(repository.saveJerProgressWithProviderState('run', {
      ownerToken: owner, version: 5, requestToken, attempted: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', providerState,
    })).rejects.toThrow(`Could not save JER progress with provider state: ${message}`);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('defines an additive nullable-state migration with lease-safe resume, terminal seeding, and legacy compatibility', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607270001_scrapedo_jer_provider_state.sql'), 'utf8');

    expect(migration).toMatch(/add column if not exists provider_state jsonb/i);
    expect(migration).toMatch(/alter table public\.draw_ingestion_runs[\s\S]*add column if not exists provider_state jsonb/i);
    expect(migration).not.toMatch(/alter table public\.scraping_source_states[\s\S]*provider_state/i);
    expect(migration).toMatch(/create (?:or replace )?function public\.jer_start_or_resume_scrapedo_backfill\(p_owner_token uuid\)/i);
    expect(migration).toMatch(/finished_at is null[\s\S]*status in \('RUNNING', 'PAUSED'\)/i);
    expect(migration).toMatch(/last_processed_at desc nulls last, started_at desc, id desc/i);
    expect(migration).toMatch(/for update/i);
    expect(migration).toMatch(/finished_at is not null[\s\S]*provider_state is not null/i);
    expect(migration).toMatch(/create (?:or replace )?function public\.jer_save_progress_with_provider_state/i);
    expect(migration).toMatch(/p_provider_state->>'schemaVersion' <> '1'/i);
    expect(migration).toMatch(/v_session_id !~ '\^\\d\+\$'/i);
    expect(migration).toMatch(/between 0 and 1000000/i);
    expect(migration).toMatch(/v_run\.provider_state is not distinct from p_provider_state/i);
    expect(migration).toMatch(/revoke all on function public\.jer_start_or_resume_scrapedo_backfill[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.jer_save_progress_with_provider_state[\s\S]*to service_role/i);
    expect(migration).not.toMatch(/(?:create or replace|drop) function public\.jer_save_progress\(/i);
  });

  it('fails closed for missing source rows and makes each new RPC independently definer-safe and locked', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607270001_scrapedo_jer_provider_state.sql'), 'utf8');
    const body = (name: string) => migration.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\nend \\$\\$;`, 'i'))?.[0] ?? '';
    const start = body('jer_start_or_resume_scrapedo_backfill');
    const save = body('jer_save_progress_with_provider_state');

    for (const rpc of [start, save]) {
      expect(rpc).toMatch(/security definer set search_path = pg_catalog, public/i);
      expect(rpc).toMatch(/scraping_source_states[\s\S]*for update/i);
      expect(rpc).toMatch(/if not found then raise exception 'JER source state not found'; end if;/i);
    }
    expect(start).toMatch(/draw_ingestion_runs[\s\S]*limit 1 for update/i);
    expect(save).toMatch(/draw_ingestion_runs where id = p_run_id for update/i);
  });

  it('returns the persisted updated run as the accepted provider-state receipt', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607270001_scrapedo_jer_provider_state.sql'), 'utf8');
    const save = migration.match(/create or replace function public\.jer_save_progress_with_provider_state[\s\S]*?\nend \$\$;/i)?.[0] ?? '';

    expect(save).toMatch(/returns table\(accepted boolean, duplicate boolean, run_id uuid, version bigint, request_token uuid, provider_state jsonb\)/i);
    expect(save).toMatch(/update public\.draw_ingestion_runs[\s\S]*?where id=p_run_id returning \* into v_run;[\s\S]*?return query select true, false, v_run\.id, v_run\.version, v_run\.request_token, v_run\.provider_state;/i);
  });

  it('uses a total exact canonical provider-state contract without unsafe numeric casts or public RPC access', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607270001_scrapedo_jer_provider_state.sql'), 'utf8');
    const validator = migration.match(/create or replace function public\.jer_is_valid_scrapedo_provider_state[\s\S]*?\n\$\$;/i)?.[0] ?? '';

    expect(validator).toMatch(/language plpgsql/i);
    expect(validator).toMatch(/if jsonb_typeof\(p_provider_state\) <> 'object' then return false; end if;/i);
    expect(validator).toMatch(/targetOrigin[\s\S]*https:\/\/jer\.com\.co/i);
    expect(validator).toMatch(/if \(select count\(\*\) from jsonb_object_keys\(p_provider_state\)\) <> 8 then return false; end if;/i);
    expect(validator).toMatch(/v_session_id !~ '\^\\d\+\$'[\s\S]*v_session_id::numeric not between 0 and 1000000/i);
    expect(validator).toMatch(/v_blocked_count !~ '\^\\d\+\$'[\s\S]*v_blocked_count::numeric < 0/i);
    expect(validator).toMatch(/if length\(v_session_id\) > 7 then return false; end if;[\s\S]*v_session_id::numeric/i);
    expect(validator).toMatch(/if length\(v_blocked_count\) > 1000 then return false; end if;[\s\S]*v_blocked_count::numeric/i);
    expect(validator).not.toMatch(/::integer|::bigint/i);
    expect(validator).toMatch(/jsonb_typeof\(p_provider_state->'schemaVersion'\) <> 'number'[\s\S]*jsonb_typeof\(p_provider_state->'provider'\) <> 'string'[\s\S]*jsonb_typeof\(p_provider_state->'tier'\) <> 'string'[\s\S]*jsonb_typeof\(p_provider_state->'sessionStatus'\) <> 'string'[\s\S]*jsonb_typeof\(p_provider_state->'pendingSuper'\) <> 'boolean'/i);
    expect(migration).toMatch(/v_state := jsonb_build_object\('schemaVersion', 1, 'provider', 'SCRAPEDO', 'targetOrigin', 'https:\/\/jer\.com\.co', 'tier', 'STANDARD', 'sessionId', null, 'sessionStatus', 'INVALID', 'standardBlockedSessionCount', 0, 'pendingSuper', false\)/i);
    expect(validator).toMatch(/if jsonb_typeof\(p_provider_state->'sessionId'\) = 'null' then[\s\S]*p_provider_state->>'sessionStatus' <> 'INVALID'[\s\S]*return false; end if;/i);
    for (const signature of [
      'jer_start_or_resume_scrapedo_backfill\\(uuid\\)',
      'jer_save_progress_with_provider_state\\(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date, jsonb\\)',
    ]) {
      expect(migration.match(new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated;`, 'ig'))).toHaveLength(1);
      expect(migration.match(new RegExp(`grant execute on function public\\.${signature} to service_role;`, 'ig'))).toHaveLength(1);
    }
  });

  it('keeps direct/null rows out of resume and makes terminal state seed-only while preserving duplicate JSON equality', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607270001_scrapedo_jer_provider_state.sql'), 'utf8');
    const legacy = readFileSync(resolve(process.cwd(), 'supabase/migrations/202607240003_jer_operational_guards.sql'), 'utf8');

    expect(migration).toMatch(/finished_at is null and status in \('RUNNING', 'PAUSED'\)[\s\S]*provider_state is not null/i);
    expect(migration).toMatch(/finished_at is not null[\s\S]*order by finished_at desc, id desc[\s\S]*insert into public\.draw_ingestion_runs/i);
    expect(migration).toMatch(/update public\.draw_ingestion_runs set owner_token = p_owner_token, version = version \+ 1, request_token = v_request_token/i);
    expect(migration).toMatch(/v_run\.provider_state is not distinct from p_provider_state/i);
    expect(migration).toMatch(/p_request_token is null/i);
    expect(migration).toMatch(/if not coalesce\(public\.jer_is_valid_scrapedo_provider_state\(p_provider_state\), false\)/i);
    expect(legacy).toMatch(/create or replace function public\.jer_save_progress\(p_run_id uuid, p_owner_token uuid, p_version bigint, p_request_token uuid/i);
    expect(legacy).toMatch(/grant execute on function public\.jer_save_progress\(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date\) to service_role/i);
  });
});
