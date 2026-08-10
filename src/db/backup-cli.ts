import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

const APPLICATION_SCHEMAS = ['public'] as const;
const usage = 'Usage: pnpm db:backup [--output PATH]';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export interface BackupOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  runProcess?: ProcessRunner;
  print?: (message: string) => void;
  error?: (message: string) => void;
}

export interface BackupConfig {
  outputPath: string;
  childEnv: NodeJS.ProcessEnv;
  secrets: string[];
}

export function parseBackupArgs(argv: string[]): { output?: string; help: boolean } {
  let output: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      help = true;
    } else if (value === '--output') {
      output = argv[index + 1];
      if (!output || output.startsWith('--')) throw new Error('--output requires a path');
      index += 1;
    } else if (value.startsWith('--output=')) {
      output = value.slice('--output='.length);
      if (!output) throw new Error('--output requires a path');
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return { output, help };
}

export function resolveBackupConfig(argv: string[], env: NodeJS.ProcessEnv, cwd: string, now: Date): BackupConfig {
  const { output } = parseBackupArgs(argv);
  const defaultName = `scraper-postgres-${timestamp(now)}.dump`;
  const requestedPath = output ?? resolve(cwd, 'backups', defaultName);
  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== '.dump') {
    throw new Error('Backup output must use the .dump extension because it is a PostgreSQL custom archive, not SQL text');
  }

  const childEnv = { ...env };
  const secrets: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim();
  delete childEnv.DATABASE_URL;
  delete childEnv.SUPABASE_URL;
  delete childEnv.SUPABASE_SERVICE_ROLE_KEY;

  if (databaseUrl) {
    applyDatabaseUrl(databaseUrl, childEnv, secrets);
  } else {
    const missing = ['PGHOST', 'PGDATABASE', 'PGUSER'].filter(name => !env[name]?.trim());
    if (missing.length > 0) {
      throw new Error('Database connection is not configured. Set DATABASE_URL or PGHOST, PGDATABASE, and PGUSER (plus PGPASSWORD or .pgpass when required)');
    }
    if (env.PGPASSWORD) secrets.push(env.PGPASSWORD);
  }

  return { outputPath, childEnv, secrets };
}

export function buildPgDumpArgs(outputPath: string): string[] {
  return [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    ...APPLICATION_SCHEMAS.map(schema => `--schema=${schema}`),
    `--file=${outputPath}`,
  ];
}

export async function runBackup(options: BackupOptions = {}): Promise<string> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const runner = options.runProcess ?? spawnProcess;
  const config = resolveBackupConfig(argv, env, cwd, now);
  const temporaryPath = resolve(dirname(config.outputPath), `.${basename(config.outputPath)}.${randomUUID()}.tmp`);

  await mkdir(dirname(config.outputPath), { recursive: true });
  try {
    await assertPgDumpAvailable(runner, config.childEnv, config.secrets);
    const result = await runner('pg_dump', buildPgDumpArgs(temporaryPath), { env: config.childEnv });
    if (result.code !== 0) {
      const detail = sanitize(result.stderr.trim(), config.secrets);
      throw new Error(`pg_dump failed with exit code ${result.code}${detail ? `: ${detail}` : ''}`);
    }

    const archive = await stat(temporaryPath).catch(() => undefined);
    if (!archive?.isFile() || archive.size === 0) throw new Error('pg_dump reported success but did not create a non-empty archive');

    await link(temporaryPath, config.outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error(`Backup output already exists: ${config.outputPath}`);
      throw error;
    });
    return config.outputPath;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function main(options: BackupOptions = {}): Promise<number> {
  const print = options.print ?? console.log;
  const printError = options.error ?? console.error;
  try {
    if (parseBackupArgs(options.argv ?? process.argv.slice(2)).help) {
      print(usage);
      return 0;
    }
    const outputPath = await runBackup(options);
    print(`PostgreSQL custom archive created: ${outputPath}`);
    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function assertPgDumpAvailable(runner: ProcessRunner, env: NodeJS.ProcessEnv, secrets: string[]): Promise<void> {
  let result: ProcessResult;
  try {
    result = await runner('pg_dump', ['--version'], { env });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('pg_dump is unavailable. Install PostgreSQL client tools and ensure pg_dump is on PATH');
    throw new Error(`Unable to start pg_dump: ${sanitize(error instanceof Error ? error.message : String(error), secrets)}`);
  }
  if (result.code !== 0) throw new Error(`pg_dump availability check failed with exit code ${result.code}`);
}

function applyDatabaseUrl(databaseUrl: string, target: NodeJS.ProcessEnv, secrets: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error('DATABASE_URL must be a complete postgres:// or postgresql:// connection URL');
  }

  target.PGHOST = parsed.hostname;
  target.PGPORT = parsed.port || '5432';
  target.PGUSER = decodeURIComponent(parsed.username);
  target.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.password) {
    target.PGPASSWORD = decodeURIComponent(parsed.password);
    secrets.push(target.PGPASSWORD);
  }
  const supportedOptions: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    channel_binding: 'PGCHANNELBINDING',
    target_session_attrs: 'PGTARGETSESSIONATTRS',
    connect_timeout: 'PGCONNECT_TIMEOUT',
  };
  for (const [name, value] of parsed.searchParams) {
    const variable = supportedOptions[name];
    if (variable) target[variable] = value;
  }
  secrets.push(databaseUrl);
}

function sanitize(value: string, secrets: string[]): string {
  return secrets.filter(Boolean).sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function spawnProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('close', code => resolveProcess({ code: code ?? 1, stdout, stderr }));
  });
}

if (process.argv[1]?.endsWith('backup-cli.ts') || process.argv[1]?.endsWith('backup-cli.js')) {
  void main().then(code => { process.exitCode = code; });
}
