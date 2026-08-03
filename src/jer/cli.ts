import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { JerOperationalOverrides, loadConfig, parseOperationalOverrides as parseConfigOperationalOverrides, type JerConfig } from './config.js';
import { JerHistoryParser } from './history-parser.js';
import { JerHttpClient } from './http-client.js';
import { ScrapedoHttpClient } from './provider.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository, type RunSummary } from './repository.js';
import { RenewableLeaseHeartbeat, toOperationalOutcome } from './operational-lifecycle.js';
import { createSupabaseClient } from './supabase.js';
import { BackfillJerResultsUseCase, DiscoverJerGamesUseCase, JerSource, SyncJerLatestResultsUseCase, type BackfillOperationalDependencies, type OperationalProgress, type OperationalTransition } from './use-cases.js';
import { ProviderStateCommitter, ScrapedoRuntime } from './scrapedo-runtime.js';
import { ScrapedoSessionPolicy, SecureSessionIdGenerator } from './session-policy.js';

const operationalOverrideNames = new Set(['batch-size', 'max-batches', 'max-results', 'max-batches-per-run', 'max-results-per-run', 'request-delay-ms', 'batch-pause-ms', 'concurrency', 'max-retries', 'block-cooldown-ms', 'rate-limit-cooldown-ms', 'lease-duration-ms', 'lease-renew-interval-ms']);
const backfillFilterNames = new Set(['game', 'games', 'from', 'to']);
export interface CliDependencies { discover: (signal?: AbortSignal) => Promise<unknown>; latest: (signal?: AbortSignal) => Promise<{ status: string; sourceState?: string }>; backfill: (options: { games?: string[]; from?: string; to?: string; signal?: AbortSignal }) => Promise<{ status: string; sourceState?: string }>; print: (value: unknown) => void; error: (value: string) => void; }
export function parseArgs(values: string[]): Record<string, string> { return Object.fromEntries(values.filter(value => value.startsWith('--')).map(value => { const [key, ...rest] = value.slice(2).split('='); return [key, rest.join('=')]; })); }
export function assertScrapedoCommandAllowed(command: string | undefined, provider: Pick<JerConfig['provider'], 'kind'>): void {
  if (provider.kind === 'SCRAPEDO' && command !== 'backfill') throw new Error('Scrape.do is available only for backfill');
}
export function parseOperationalOverrides(values: Record<string, string>): JerOperationalOverrides {
  const unknown = Object.keys(values).find(key => !operationalOverrideNames.has(key));
  if (unknown) throw new Error(`Unknown JER operational override: ${unknown}`);
  return parseConfigOperationalOverrides({
    batchSize: values['batch-size'],
    maxBatchesPerRun: values['max-batches'] ?? values['max-batches-per-run'],
    maxResultsPerRun: values['max-results'] ?? values['max-results-per-run'],
    delayMs: values['request-delay-ms'],
    batchPauseMs: values['batch-pause-ms'],
    concurrency: values.concurrency,
    maxRetries: values['max-retries'],
    blockCooldownMs: values['block-cooldown-ms'],
    rateLimitCooldownMs: values['rate-limit-cooldown-ms'],
    leaseDurationMs: values['lease-duration-ms'],
    leaseRenewIntervalMs: values['lease-renew-interval-ms']
  });
}
export async function runCli(argv: string[], dependencies: CliDependencies, signal?: AbortSignal): Promise<number> {
  const [command, ...values] = argv; const args = parseArgs(values); const games = args.games ? args.games.split(',').map(value => value.trim()).filter(Boolean) : args.game ? [args.game] : undefined;
  if (command === 'backfill') parseOperationalOverrides(Object.fromEntries(Object.entries(args).filter(([key]) => !backfillFilterNames.has(key))));
  if (command === 'discover') { const result = await dependencies.discover(signal); dependencies.print(result); return signal?.aborted ? 130 : isCommandSummary(result) ? exitCode(result) : 0; }
  if (command === 'latest') return exitCode(await dependencies.latest(signal));
  if (command === 'backfill') return exitCode(await dependencies.backfill({ games, from: args.from, to: args.to, signal }));
  dependencies.error('Usage: pnpm scrape:jer:{discover|latest|backfill} [--game=CODE] [--games=A,B] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]'); return 1;
}
function exitCode(summary: { status: string; sourceState?: string }): number { if (summary.sourceState === 'RATE_LIMITED') return 4; if (summary.status === 'PAUSED') return 0; return summary.status === 'SUCCESS' ? 0 : summary.status === 'PARTIAL' ? 2 : summary.status === 'BLOCKED' ? 3 : summary.status === 'CANCELLED' ? 130 : 1; }
function isCommandSummary(value: unknown): value is { status: string; sourceState?: string } { return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'string'; }

export interface SignalProcess { on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; }
export async function runWithSignals(operation: (signal: AbortSignal) => Promise<number>, processLike: SignalProcess = process): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('JER command cancelled by signal'));
  processLike.on('SIGINT', abort); processLike.on('SIGTERM', abort);
  try { const code = await operation(controller.signal); return controller.signal.aborted ? 130 : code; }
  finally { processLike.removeListener('SIGINT', abort); processLike.removeListener('SIGTERM', abort); }
}

export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  createClient?: () => unknown;
  createRepository?: (client: unknown) => DrawRepository;
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2); const args = parseArgs(argv.slice(1));
  const operationalArgs = argv[0] === 'backfill' ? Object.fromEntries(Object.entries(args).filter(([key]) => !backfillFilterNames.has(key))) : {};
  const config = loadConfig(options.env ?? process.env, parseOperationalOverrides(operationalArgs));
  assertScrapedoCommandAllowed(argv[0], config.provider);
  if (!config.enabled) { console.error('JER scraper is disabled (JER_SCRAPER_ENABLED=false).'); return 1; }
  const databaseClient = (options.createClient ?? createSupabaseClient)();
  const repository = options.createRepository?.(databaseClient) ?? new DrawRepository(databaseClient as ConstructorParameters<typeof DrawRepository>[0]);
  const client = new JerHttpClient({ ...config, logger: event => console.error(JSON.stringify(event)) });
  const source = new JerSource(client, new JerMainPageParser(config.baseUrl), new JerHistoryParser(), config.resultsUrl);
  return runWithSignals(signal => runCli(argv, {
    discover: async current => withJerLease(repository, config, current, async (guarded, owner) => { try { const games = await new DiscoverJerGamesUseCase(source, repository).execute(guarded); games.forEach(game => console.log(`${game.code}\t${game.type}\t${game.name}\t${game.detailUrl}`)); return games; } catch (error) { return persistOperationalFailure(repository, owner, undefined, error, config); } }),
    latest: async current => withJerLease(repository, config, current, async (guarded, owner) => { const runId = await repository.startRun('LATEST', owner); try { const summary = await new SyncJerLatestResultsUseCase(source, repository).execute(guarded, runId); printSummary(summary); return summary; } catch (error) { const summary = await persistOperationalFailure(repository, owner, runId, error, config); printSummary(summary); return summary; } }),
    backfill: async options => { const summary = await new BackfillJerResultsUseCase(source, repository, createOperationalDependencies(repository, config, source)).executeOperational(options); printSummary(summary); return summary; },
    print: value => console.log(value), error: value => console.error(value)
  }, signal));
}
function printSummary(summary: { id: string; status: string; gamesQueried: number; datesQueried: number; resultsFound: number; resultsInserted: number; resultsUpdated: number; resultsSkipped: number; errors: string[] }) { console.log(JSON.stringify(summary, null, 2)); }

export function createOperationalDependencies(repository: DrawRepository, config: ReturnType<typeof loadConfig>, source?: JerSource): BackfillOperationalDependencies {
  const ownerToken = randomUUID();
  const scrapedoProvider = config.provider.kind === 'SCRAPEDO' ? config.provider : undefined;
  return { ownerToken, leaseDurationMs: config.leaseDurationMs, renewIntervalMs: config.leaseRenewIntervalMs, batchSize: config.batchSize, maxBatches: config.maxBatchesPerRun, maxResults: config.maxResultsPerRun, batchPauseMs: config.batchPauseMs, blockCooldownMs: config.blockCooldownMs, rateLimitCooldownMs: config.rateLimitCooldownMs,
    nextRequestToken: randomUUID, acquireAndGate: () => repository.acquireJerLease(ownerToken, config.leaseDurationMs), ensureActive: async () => ({ state: (await repository.acquireJerLease(ownerToken, config.leaseDurationMs)).state }), renew: () => repository.renewJerLease(ownerToken, config.leaseDurationMs), release: async () => { await repository.releaseJerLease(ownerToken); },
    saveProgress: async (runId: string, progress: OperationalProgress) => { await repository.saveJerProgress(runId, { ownerToken, ...progress }); },
    startProviderRun: scrapedoProvider ? async progress => {
      if (!source) throw new Error('Scrape.do backfill source is required');
      const resumed = await repository.startOrResumeScrapedoBackfill(ownerToken);
      const policy = new ScrapedoSessionPolicy({ generator: new SecureSessionIdGenerator(), maxStandardBlockedSessions: scrapedoProvider.maxStandardBlockedSessions, superEnabled: scrapedoProvider.superEnabled });
      const state = resumed.providerState ?? (await policy.execute(undefined, async () => ({ kind: 'provider_error' as const }))).state;
      const committer = new ProviderStateCommitter({ save: write => repository.saveJerProgressWithProviderState(write.runId, write) });
      const runtime = new ScrapedoRuntime({ policy, committer, retryDelayMs: config.delayMs, sleep: sleepWithAbort });
      runtime.bind({ runId: resumed.runId, ownerToken, committed: { version: resumed.version, requestToken: resumed.requestToken, providerState: state } });
      const logger = (event: Record<string, unknown>) => console.error(JSON.stringify(event));
      source.bindScrapedo({ runtime, progress, transportFactory: attempt => new ScrapedoHttpClient({ endpoint: scrapedoProvider.endpoint, token: scrapedoProvider.token, timeoutMs: config.timeoutMs, userAgent: config.userAgent, sessionId: attempt.sessionId, super: attempt.transportOptions.super, logger }), logger });
      return { runId: resumed.runId, saveProgress: async write => { await runtime.saveProgress(write); } };
    } : undefined,
    transition403: async (runId: string, details: OperationalTransition) => { await repository.transitionJer403(ownerToken, runId, details.cooldownMs, details.error); }, transition429: async (runId: string, details: OperationalTransition) => { await repository.transitionJer429(ownerToken, runId, details.cooldownMs, details.error); }, sleep: sleepWithAbort };
}

async function withJerLease<T>(repository: DrawRepository, config: ReturnType<typeof loadConfig>, signal: AbortSignal | undefined, operation: (signal: AbortSignal, ownerToken: string) => Promise<T>): Promise<T | { status: string; sourceState?: string }> {
  const controller = new AbortController(); const ownerToken = randomUUID(); const abort = () => controller.abort(signal?.reason ?? new Error('JER command cancelled'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const lease = await repository.acquireJerLease(ownerToken, config.leaseDurationMs);
  if (!lease.acquired || lease.state !== 'ACTIVE') return { status: lease.state === 'BLOCKED' ? 'BLOCKED' : 'FAILED', sourceState: lease.state };
  const heartbeat = new RenewableLeaseHeartbeat({ ownerToken, renew: () => repository.renewJerLease(ownerToken, config.leaseDurationMs), controller, clock: { now: Date.now, sleep: sleepWithAbort }, leaseDurationMs: config.leaseDurationMs, renewIntervalMs: config.leaseRenewIntervalMs, onFatal: () => undefined });
  heartbeat.start();
  try { return controller.signal.aborted ? { status: 'CANCELLED' } : await operation(controller.signal, ownerToken); }
  finally { heartbeat.stop(); signal?.removeEventListener('abort', abort); await repository.releaseJerLease(ownerToken); }
}

export async function persistOperationalFailure(repository: DrawRepository, ownerToken: string, runId: string | undefined, error: unknown, config: Pick<ReturnType<typeof loadConfig>, 'blockCooldownMs' | 'rateLimitCooldownMs'>): Promise<RunSummary> {
  const outcome = toOperationalOutcome(error);
  if (!outcome) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (outcome.sourceState === 'BLOCKED') await repository.transitionJer403(ownerToken, runId, config.blockCooldownMs, message);
  else await repository.transitionJer429(ownerToken, runId, Math.max(outcome.retryAfterMs ?? 0, config.rateLimitCooldownMs), message);
  return { id: runId ?? '', status: outcome.runStatus, sourceState: outcome.sourceState, gamesQueried: 0, datesQueried: 0, resultsFound: 0, resultsInserted: 0, resultsUpdated: 0, resultsSkipped: 0, errors: [message] };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { if (signal?.aborted) { reject(signal.reason); return; } const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); }

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
