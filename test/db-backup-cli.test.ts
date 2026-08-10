import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPgDumpArgs, main, parseBackupArgs, resolveBackupConfig, runBackup, type ProcessRunner } from '../src/db/backup-cli.js';

const temporaryDirectories: string[] = [];
const connection = 'postgresql://scraper:super-secret@db.example.com:5432/postgres?sslmode=require';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  }));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scraper-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}

function successfulRunner(onDump?: (args: string[], env: NodeJS.ProcessEnv) => void): ProcessRunner {
  return vi.fn(async (_command, args, options) => {
    if (args[0] === '--version') return { code: 0, stdout: 'pg_dump (PostgreSQL) 17.5', stderr: '' };
    onDump?.(args, options.env);
    const output = args.find((value: string) => value.startsWith('--file='))?.slice('--file='.length);
    if (!output) throw new Error('test runner did not receive output');
    await writeFile(output, 'PGDMP test archive');
    return { code: 0, stdout: '', stderr: '' };
  });
}

describe('database backup CLI', () => {
  it('builds a complete custom archive command scoped to the project-owned public schema', () => {
    expect(buildPgDumpArgs('backup.tmp')).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '--schema=public',
      '--file=backup.tmp',
    ]);
  });

  it('parses both output forms and rejects ambiguous output semantics', () => {
    expect(parseBackupArgs(['--output', 'one.dump'])).toEqual({ output: 'one.dump', help: false });
    expect(parseBackupArgs(['--output=two.dump'])).toEqual({ output: 'two.dump', help: false });
    expect(() => resolveBackupConfig(['--output=backup.sql'], { DATABASE_URL: connection }, 'C:\\repo', new Date())).toThrow('must use the .dump extension');
  });

  it('uses a timestamped default and maps a URL to libpq environment variables', () => {
    const config = resolveBackupConfig([], { DATABASE_URL: connection, SUPABASE_SERVICE_ROLE_KEY: 'not-forwarded' }, 'C:\\repo', new Date('2026-08-09T12:34:56.000Z'));
    expect(config.outputPath).toMatch(/backups[\\/]scraper-postgres-20260809-123456\.dump$/);
    expect(config.childEnv).toMatchObject({ PGHOST: 'db.example.com', PGPORT: '5432', PGUSER: 'scraper', PGPASSWORD: 'super-secret', PGDATABASE: 'postgres', PGSSLMODE: 'require' });
    expect(config.childEnv).not.toHaveProperty('DATABASE_URL');
    expect(config.childEnv).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('fails before subprocess execution when connection configuration is absent', async () => {
    const runner = vi.fn<ProcessRunner>();
    await expect(runBackup({ argv: [], env: {}, cwd: await temporaryDirectory(), runProcess: runner })).rejects.toThrow('Database connection is not configured');
    expect(runner).not.toHaveBeenCalled();
  });

  it('publishes a successful dump atomically without exposing connection data in arguments', async () => {
    const cwd = await temporaryDirectory();
    const output = join(cwd, 'exports', 'portable.dump');
    const runner = successfulRunner((args, env) => {
      expect(args.join(' ')).not.toContain('super-secret');
      expect(args.join(' ')).not.toContain('db.example.com');
      expect(env.PGPASSWORD).toBe('super-secret');
    });

    await expect(runBackup({ argv: ['--output', output], env: { DATABASE_URL: connection }, cwd, runProcess: runner })).resolves.toBe(output);
    await expect(readFile(output, 'utf8')).resolves.toBe('PGDMP test archive');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('removes partial output and redacts secrets when pg_dump fails', async () => {
    const cwd = await temporaryDirectory();
    let temporaryOutput = '';
    const runner: ProcessRunner = vi.fn(async (_command, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'pg_dump 17', stderr: '' };
      temporaryOutput = args.find((value: string) => value.startsWith('--file='))?.slice('--file='.length) ?? '';
      await writeFile(temporaryOutput, 'partial');
      return { code: 1, stdout: '', stderr: `connection ${connection} password super-secret failed` };
    });

    const operation = runBackup({ argv: ['--output=failed.dump'], env: { DATABASE_URL: connection }, cwd, runProcess: runner });
    await expect(operation).rejects.toThrow('connection [REDACTED] password [REDACTED] failed');
    await expect(readFile(join(cwd, 'failed.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(temporaryOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails clearly when pg_dump is unavailable and does not leave an archive', async () => {
    const cwd = await temporaryDirectory();
    const unavailable: ProcessRunner = vi.fn(async () => { throw Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }); });
    const errors: string[] = [];

    await expect(main({ argv: ['--output=missing.dump'], env: { DATABASE_URL: connection }, cwd, runProcess: unavailable, error: value => errors.push(value) })).resolves.toBe(1);
    expect(errors).toEqual(['pg_dump is unavailable. Install PostgreSQL client tools and ensure pg_dump is on PATH']);
    expect(errors.join(' ')).not.toContain('super-secret');
    await expect(readFile(join(cwd, 'missing.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite an existing final archive', async () => {
    const cwd = await temporaryDirectory();
    const output = join(cwd, 'existing.dump');
    await mkdir(cwd, { recursive: true });
    await writeFile(output, 'original');

    await expect(runBackup({ argv: [`--output=${output}`], env: { DATABASE_URL: connection }, cwd, runProcess: successfulRunner() })).rejects.toThrow('Backup output already exists');
    await expect(readFile(output, 'utf8')).resolves.toBe('original');
  });
});
