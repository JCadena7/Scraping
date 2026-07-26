import { DiscoveredGame, JerBlockedError, JerRateLimitError, NormalizedDrawResult, assertDate, type IngestionStatus, type SourceState } from './domain.js';
import { JerHttpClient } from './http-client.js';
import { JerHistoryParser } from './history-parser.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository, RunSummary } from './repository.js';
import { RenewableLeaseHeartbeat, toOperationalOutcome } from './operational-lifecycle.js';

export class JerSource {
  constructor(private readonly http: JerHttpClient, private readonly main: JerMainPageParser, private readonly history: JerHistoryParser, private readonly resultsUrl: string) {}
  async discover(signal?: AbortSignal) { return this.main.parseGames(await this.http.get(this.resultsUrl, signal)); }
  async latest(games: DiscoveredGame[], signal?: AbortSignal) { return this.main.parseLatest(await this.http.get(this.resultsUrl, signal), games); }
  async mainSnapshot(signal?: AbortSignal) { const html = await this.http.get(this.resultsUrl, signal); const games = this.main.parseGames(html); return { games, latest: this.main.parseLatest(html, games) }; }
  async dates(url: string, signal?: AbortSignal) { return this.history.getDates(await this.http.get(url, signal)); }
  async historical(game: DiscoveredGame, date: string, signal?: AbortSignal): Promise<NormalizedDrawResult> { assertDate(date); return this.history.parse(await this.http.postForm(game.detailUrl, { fecha: date }, signal), game, date, game.detailUrl); }
}

export class DiscoverJerGamesUseCase {
  constructor(private readonly source: JerSource, private readonly repository: DrawRepository) {}
  async execute(signal?: AbortSignal) { const games = await this.source.discover(signal); await this.repository.upsertGames(games); return games; }
}

export class SyncJerLatestResultsUseCase {
  constructor(private readonly source: JerSource, private readonly repository: DrawRepository) {}
  async execute(signal?: AbortSignal, existingRunId?: string): Promise<RunSummary> {
    const runId = existingRunId ?? await this.repository.startRun('LATEST'); const summary = emptySummary();
    try { const snapshot = await this.source.mainSnapshot(signal); summary.gamesQueried = snapshot.games.length; await this.repository.upsertGames(snapshot.games); summary.resultsFound = snapshot.latest.results.length; summary.errors.push(...snapshot.latest.rejected.map(item => `row ${item.row}: ${item.reason}`)); for (const result of snapshot.latest.results) await recordResult(this.repository, result, summary); const status = summary.errors.length ? 'PARTIAL' : 'SUCCESS'; await this.repository.finishRun(runId, summary, status); return { id: runId, status, ...summary }; }
    catch (error) { if (toOperationalOutcome(error)) throw error; summary.errors.push(error instanceof Error ? error.message : String(error)); await this.repository.finishRun(runId, summary, 'FAILED'); return { id: runId, status: 'FAILED', ...summary }; }
  }
}

export interface BackfillOptions { games?: string[]; from?: string; to?: string; signal?: AbortSignal; }
export interface OperationalProgress {
  version: number;
  requestToken: string;
  attempted: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  status: IngestionStatus;
  nextPendingDate?: string;
  priorSnapshot?: unknown;
  gamesQueried: number;
  datesQueried: number;
  processedBatches: number;
  totalMissing: number;
}
export interface BackfillOperationalDependencies {
  ownerToken: string;
  nextRequestToken(): string;
  leaseDurationMs: number;
  renewIntervalMs: number;
  batchSize: number;
  maxBatches: number;
  maxResults: number;
  batchPauseMs: number;
  blockCooldownMs: number;
  rateLimitCooldownMs: number;
  priorSnapshot?: unknown;
  acquireAndGate(): Promise<{ acquired: boolean; state: SourceState }>;
  ensureActive(): Promise<{ state: SourceState }>;
  renew(ownerToken: string): Promise<boolean>;
  release(): Promise<void>;
  saveProgress(runId: string, progress: OperationalProgress): Promise<void>;
  transition403(runId: string, details: OperationalTransition): Promise<void>;
  transition429(runId: string, details: OperationalTransition): Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface OperationalTransition {
  url: string;
  status: 403 | 429;
  gameCode?: string;
  date?: string;
  error: string;
  cooldownMs: number;
  nextPendingDate?: string;
}

export class BackfillJerResultsUseCase {
  constructor(private readonly source: JerSource, private readonly repository: DrawRepository, private readonly operational?: BackfillOperationalDependencies) {}
  async execute(options: BackfillOptions = {}): Promise<RunSummary> {
    if (options.from) assertDate(options.from); if (options.to) assertDate(options.to); const runId = await this.repository.startRun('BACKFILL'); const summary = emptySummary();
    try { const requested = options.games?.length ? options.games : undefined; if (requested) { const catalog = await this.repository.listGames(); if (!catalog.length) throw new Error('Cannot validate requested game filters because the persisted JER catalog is empty; run discover first'); const unknown = requested.filter(code => !catalog.some(game => game.code === code)); if (unknown.length) throw new Error(`Unknown requested game code(s): ${unknown.join(', ')}`); }
      const discovered = await this.source.discover(options.signal); await this.repository.upsertGames(discovered); const games = requested ? discovered.filter(game => requested.includes(game.code)) : discovered; summary.gamesQueried = games.length; for (const game of games) { try { const dates = await this.source.dates(game.detailUrl, options.signal); const existing = new Set(await this.repository.existingDates(game.code, options.from, options.to)); const missing = dates.filter(date => (!options.from || date >= options.from) && (!options.to || date <= options.to) && !existing.has(date)); for (const date of missing) { summary.datesQueried++; try { const result = await this.source.historical(game, date, options.signal); summary.resultsFound++; await recordResult(this.repository, result, summary); } catch (error) { if (options.signal?.aborted) throw error; summary.errors.push(`${game.code} ${date}: ${error instanceof Error ? error.message : String(error)}`); } } } catch (error) { if (options.signal?.aborted) throw error; summary.errors.push(`${game.code}: ${error instanceof Error ? error.message : String(error)}`); } } const status = summary.errors.length ? 'PARTIAL' : 'SUCCESS'; await this.repository.finishRun(runId, summary, status); return { id: runId, status, ...summary }; }
    catch (error) { summary.errors.push(error instanceof Error ? error.message : String(error)); await this.repository.finishRun(runId, summary, 'FAILED'); return { id: runId, status: 'FAILED', ...summary }; }
  }

  async executeOperational(options: BackfillOptions = {}): Promise<RunSummary> {
    if (!this.operational) throw new Error('Operational backfill dependencies are required');
    if (options.from) assertDate(options.from); if (options.to) assertDate(options.to);
    const guard = this.operational;
    const lease = await guard.acquireAndGate();
    if (!lease.acquired || lease.state !== 'ACTIVE') return operationalSummary(lease.state === 'RATE_LIMITED' ? 'PAUSED' : lease.state === 'BLOCKED' ? 'BLOCKED' : 'FAILED', lease.state);

    let released = false;
    const releaseOnce = async () => { if (!released) { released = true; await guard.release(); } };
    let runId: string | undefined;
    const summary = emptySummary();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason ?? new Error('JER backfill cancelled'));
    if (options.signal?.aborted) abortFromCaller(); else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let heartbeatError: Error | undefined;
    const heartbeat = new RenewableLeaseHeartbeat({ ownerToken: guard.ownerToken, renew: guard.renew, controller, clock: { now: () => Date.now(), sleep: guard.sleep }, leaseDurationMs: guard.leaseDurationMs, renewIntervalMs: guard.renewIntervalMs, onFatal: error => { heartbeatError = error; } });
    const progress: OperationalProgress = { version: 0, requestToken: '', attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, status: 'RUNNING', priorSnapshot: guard.priorSnapshot, gamesQueried: 0, datesQueried: 0, processedBatches: 0, totalMissing: 0 };
    const save = async (status: IngestionStatus, nextPendingDate?: string) => {
      progress.version++; progress.requestToken = guard.nextRequestToken(); progress.status = status; progress.nextPendingDate = nextPendingDate;
      if (!runId) throw new Error('Operational run was not initialized');
      await guard.saveProgress(runId, { ...progress });
    };
    const ensure = async () => {
      if (heartbeatError || controller.signal.aborted) throw heartbeatError ?? new Error('Lease heartbeat aborted');
      const state = await guard.ensureActive();
      if (state.state !== 'ACTIVE') throw new Error(`Source is ${state.state}`);
      if (!await guard.renew(guard.ownerToken)) throw new Error('Lease renewal was rejected');
    };
    const finish = async (status: IngestionStatus) => {
      if (runId) await this.repository.finishRun(runId, summary, status);
      return { id: runId ?? '', status, ...summary };
    };

    try {
      runId = await this.repository.startRun('BACKFILL', guard.ownerToken);
      await save('RUNNING');
      heartbeat.start();
      const requested = options.games?.length ? options.games : undefined;
      if (requested) {
        const catalog = await this.repository.listGames();
        if (!catalog.length) throw new Error('Cannot validate requested game filters because the persisted JER catalog is empty; run discover first');
        const unknown = requested.filter(code => !catalog.some(game => game.code === code));
        if (unknown.length) throw new Error(`Unknown requested game code(s): ${unknown.join(', ')}`);
      }
      await ensure();
      const discovered = await this.source.discover(controller.signal);
      await this.repository.upsertGames(discovered);
      const selected = requested ? discovered.filter(game => requested.includes(game.code)) : discovered;
      summary.gamesQueried = selected.length;
      progress.gamesQueried = selected.length;
      const pending: Array<{ game: DiscoveredGame; date: string }> = [];
      for (const game of selected) {
        await ensure();
        const dates = await this.source.dates(game.detailUrl, controller.signal);
        const existing = new Set(await this.repository.existingDates(game.code, options.from, options.to));
        for (const date of dates.sort()) {
          if ((!options.from || date >= options.from) && (!options.to || date <= options.to) && !existing.has(date)) pending.push({ game, date });
        }
      }
      progress.totalMissing = pending.length;
      await save('RUNNING', pending[0]?.date);

      let cursor = 0;
      let batches = 0;
      while (cursor < pending.length && progress.attempted < guard.maxResults && batches < guard.maxBatches) {
        const batchEnd = Math.min(cursor + guard.batchSize, pending.length, cursor + (guard.maxResults - progress.attempted));
        for (; cursor < batchEnd; cursor++) {
          const item = pending[cursor];
          const nextPendingDate = pending[cursor + 1]?.date;
          await ensure();
          progress.attempted++; progress.datesQueried++; summary.datesQueried++;
          await save('RUNNING', item.date);
          try {
            const draw = await this.source.historical(item.game, item.date, controller.signal);
            summary.resultsFound++;
            let action: 'inserted' | 'updated' | 'skipped';
            try { action = await this.repository.upsertResult(draw); } catch (error) { throw new FatalBackfillError(messageOf(error)); }
            progress[action]++; summary[`results${action[0].toUpperCase()}${action.slice(1)}` as 'resultsInserted' | 'resultsUpdated' | 'resultsSkipped']++;
            await save('RUNNING', nextPendingDate);
          } catch (error) {
            if (error instanceof JerBlockedError) {
              await guard.transition403(runId, { url: error.url, status: 403, gameCode: item.game.code, date: item.date, error: error.message, cooldownMs: guard.blockCooldownMs, nextPendingDate: item.date });
              return { id: runId, status: 'BLOCKED', sourceState: 'BLOCKED', ...summary };
            }
            if (error instanceof JerRateLimitError) {
              const cooldownMs = Math.max(error.retryAfterMs ?? 0, guard.rateLimitCooldownMs);
              await guard.transition429(runId, { url: error.url, status: 429, gameCode: item.game.code, date: item.date, error: error.message, cooldownMs, nextPendingDate: item.date });
              return { id: runId, status: 'PAUSED', sourceState: 'RATE_LIMITED', ...summary };
            }
            if (isRepositoryFailure(error)) throw error;
            progress.failed++; summary.errors.push(`${item.game.code} ${item.date}: ${messageOf(error)}`);
            await save('RUNNING', nextPendingDate);
          }
        }
        batches++; progress.processedBatches = batches;
        if (cursor < pending.length && progress.attempted < guard.maxResults && batches < guard.maxBatches) await guard.sleep(guard.batchPauseMs, controller.signal);
      }
      const status: IngestionStatus = cursor < pending.length ? 'PAUSED' : summary.errors.length ? 'PARTIAL' : 'SUCCESS';
      await save(status, pending[cursor]?.date);
      return await finish(status);
    } catch (error) {
      if (runId && error instanceof JerBlockedError) {
        await guard.transition403(runId, { url: error.url, status: 403, error: error.message, cooldownMs: guard.blockCooldownMs, nextPendingDate: progress.nextPendingDate });
        return { id: runId, status: 'BLOCKED', sourceState: 'BLOCKED', ...summary };
      }
      if (runId && error instanceof JerRateLimitError) {
        await guard.transition429(runId, { url: error.url, status: 429, error: error.message, cooldownMs: Math.max(error.retryAfterMs ?? 0, guard.rateLimitCooldownMs), nextPendingDate: progress.nextPendingDate });
        return { id: runId, status: 'PAUSED', sourceState: 'RATE_LIMITED', ...summary };
      }
      const status: IngestionStatus = options.signal?.aborted ? 'CANCELLED' : 'FAILED';
      summary.errors.push(messageOf(error));
      try { await save(status, progress.nextPendingDate); } finally { if (runId) await this.repository.finishRun(runId, summary, status); }
      return { id: runId ?? '', status, ...summary };
    } finally {
      heartbeat.stop();
      options.signal?.removeEventListener('abort', abortFromCaller);
      await releaseOnce();
    }
  }
}

function emptySummary() { return { gamesQueried: 0, datesQueried: 0, resultsFound: 0, resultsInserted: 0, resultsUpdated: 0, resultsSkipped: 0, errors: [] as string[] }; }
async function recordResult(repository: DrawRepository, result: NormalizedDrawResult, summary: ReturnType<typeof emptySummary>) { try { const action = await repository.upsertResult(result); summary[`results${action[0].toUpperCase()}${action.slice(1)}` as 'resultsInserted' | 'resultsUpdated' | 'resultsSkipped']++; } catch (error) { summary.errors.push(error instanceof Error ? error.message : String(error)); } }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRepositoryFailure(error: unknown): boolean { return error instanceof FatalBackfillError; }
function operationalSummary(status: IngestionStatus, sourceState?: SourceState): RunSummary { return { id: '', status, sourceState, ...emptySummary() }; }
class FatalBackfillError extends Error {}
