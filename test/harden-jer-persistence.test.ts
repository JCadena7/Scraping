import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), 'supabase/migrations/202607240001_harden_jer_persistence.sql');

describe('harden JER persistence migration', () => {
  it('replaces the draw-number trigger before declaring its canonical definition', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, 'utf8');
    const dropTrigger = /drop trigger if exists preserve_jer_draw_number on public\.draw_results;/i;
    const createTrigger = /create trigger preserve_jer_draw_number\s+before update on public\.draw_results\s+for each row execute function public\.preserve_jer_draw_number\(\);/i;

    expect(migration).toMatch(/create or replace function public\.preserve_jer_draw_number\(\)/i);
    expect(migration).toMatch(createTrigger);
    expect(migration.search(dropTrigger)).toBeGreaterThanOrEqual(0);
    expect(migration.search(dropTrigger)).toBeLessThan(migration.search(createTrigger));
  });
});
