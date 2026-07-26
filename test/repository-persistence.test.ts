import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DrawRepository } from '../src/jer/repository.js';
import { canonicalResultHash } from '../src/jer/hash.js';
import { createSupabaseClient } from '../src/jer/supabase.js';

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
