import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), 'supabase/migrations/202607240003_jer_operational_guards.sql');

describe('JER operational persistence migration', () => {
  it('adds the singleton source state, complete run progress, and restricted RPC boundary', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(/create table public\.scraping_source_states/i);
    expect(migration).toMatch(/check \(source_code = 'JER' and source_host = 'jer\.com\.co'\)/i);
    expect(migration).toMatch(/owner_token uuid/i);
    expect(migration).toMatch(/lease_expires_at timestamptz/i);
    expect(migration).toMatch(/status_history jsonb not null default '\[\]'::jsonb/i);
    expect(migration).toMatch(/drop constraint if exists draw_ingestion_runs_status_check/i);
    expect(migration).toMatch(/check \(status in \('RUNNING','PAUSED','SUCCESS','PARTIAL','FAILED','BLOCKED','CANCELLED'\)\)/i);
    expect(migration).toMatch(/for update/i);
    expect(migration).toMatch(/clock_timestamp\(\)/i);

    for (const rpc of ['jer_acquire_and_gate', 'jer_renew_lease', 'jer_release_lease', 'jer_transition_403', 'jer_transition_429', 'jer_save_progress']) {
      expect(migration).toMatch(new RegExp(`function public\\.${rpc}\\(`, 'i'));
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*from public, anon, authenticated`, 'i'));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*to service_role`, 'i'));
    }
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = pg_catalog, public/i);
    expect(migration).not.toMatch(/pg_advisory/i);
  });

  it('treats a duplicate progress request as idempotent only when its absolute payload matches', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(/p_version = v_run\.version[\s\S]*p_request_token = v_run\.request_token[\s\S]*v_run\.status = p_status[\s\S]*v_run\.attempted_results = p_attempted[\s\S]*v_run\.results_inserted = p_inserted[\s\S]*v_run\.results_updated = p_updated[\s\S]*v_run\.results_skipped = p_skipped[\s\S]*v_run\.failed_results = p_failed[\s\S]*v_run\.next_pending_date is not distinct from p_next_pending_date/i);
  });

  it.each([['403', 'BLOCKED'], ['429', 'PAUSED']])('owns terminal run version in transition %s', (code, status) => {
    const migration = readFileSync(migrationPath, 'utf8');
    const transition = migration.match(new RegExp(`function public\\.jer_transition_${code}\\([\\s\\S]*?end \\$\\$;`, 'i'))?.[0] ?? '';
    expect(transition).toMatch(new RegExp(`update public\\.draw_ingestion_runs set status='${status}'[\\s\\S]*version=version\\+1`, 'i'));
    expect(migration).toMatch(/if p_version <> v_run\.version \+ 1[\s\S]*raise exception 'stale progress version or request token'/i);
  });
});
