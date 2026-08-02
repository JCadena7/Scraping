import { DiscoveredGame, JerBlockedError, JerError, JerHtmlStructureChangedError, JerRateLimitError, NormalizedDrawResult, assertDate, type IngestionStatus, type SourceState } from './domain.js';
import { type JerTransport } from './http-client.js';
import { JerHistoryParser } from './history-parser.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository, RunSummary } from './repository.js';
import { RenewableLeaseHeartbeat, toOperationalOutcome } from './operational-lifecycle.js';
import { isVerificationPage, classifyHistoricalHtml } from './response-classifier.js';
import { ScrapedoProviderError, ScrapedoRuntime, classifyScrapedoFailure, classifyScrapedoResponse, type JerOperation, type ProgressSupplier, type ProgressWriteWithoutVersionTokenProviderState, type ScrapedoRawResponse } from './scrapedo-runtime.js';
import type { SessionAttempt } from './session-policy.js';

export class JerSource {
  private scrapedo?: ScrapedoSourceRuntime;
  constructor(private readonly http: JerTransport, private readonly main: JerMainPageParser, private readonly history: JerHistoryParser, private readonly resultsUrl: string, scrapedo?: ScrapedoSourceRuntime) { this.scrapedo = scrapedo; }
  bindScrapedo(runtime: ScrapedoSourceRuntime): void { if (this.scrapedo) throw new Error('Scrape.do source is already bound'); this.scrapedo = runtime; }
  canRetryScrapedoBlockedRequest(): boolean { return this.scrapedo?.runtime.canRetryBlockedRequest() ?? false; }
  async discover(signal?: AbortSignal) { return this.execute(this.resultsUrl, { method: 'GET' }, html => this.main.parseGames(html), signal); }
  async latest(games: DiscoveredGame[], signal?: AbortSignal) { return this.execute(this.resultsUrl, { method: 'GET' }, html => this.main.parseLatest(html, games), signal); }
  async mainSnapshot(signal?: AbortSignal) { return this.execute(this.resultsUrl, { method: 'GET' }, html => { const games = this.main.parseGames(html); return { games, latest: this.main.parseLatest(html, games) }; }, signal); }
  async dates(url: string, signal?: AbortSignal) { return this.execute(url, { method: 'GET' }, html => this.history.getDates(html), signal); }
  async historical(game: DiscoveredGame, date: string, signal?: AbortSignal): Promise<NormalizedDrawResult | null> {
    assertDate(date);
    if (!this.scrapedo) return this.history.parse(await this.http.postForm(game.detailUrl, { fecha: date }, signal), game, date, game.detailUrl);
    return this.execute(game.detailUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ fecha: date }).toString() }, html => {
      const classified = classifyHistoricalHtml(html, this.history, game, date, game.detailUrl);
      if (classified.kind === 'valid_no_results') return null;
      if (classified.kind === 'verification_page') throw new JerError('JER verification page', 'JER_VERIFICATION_PAGE');
      return classified.result;
    }, signal, true);
  }

  private async execute<T>(url: string, init: RequestInit, parse: (html: string) => T, signal?: AbortSignal, allowNoResults = false): Promise<T> {
    if (!this.scrapedo) return parse(init.method === 'POST' ? await this.http.postForm(url, Object.fromEntries(new URLSearchParams(String(init.body))), signal) : await this.http.get(url, signal));
    const scrapedo = this.scrapedo;
    const attemptFactory = ((attempt: SessionAttempt) => async (currentSignal?: AbortSignal) => {
      try {
        const response = await scrapedo.transportFactory(attempt).requestRaw(url, init, currentSignal);
        return classifyScrapedoResponse(response, url, html => this.classifyBody(html, parse, allowNoResults));
      } catch (error) { return classifyScrapedoFailure(error, currentSignal); }
    }) as never;
    const operation = await scrapedo.runtime.executeFrom(scrapedo.progress, signal, attemptFactory) as JerOperation<T>;
    if (operation.ok) return operation.value as T;
    throw operationError(operation, url);
  }

  private classifyBody<T>(html: string, parse: (html: string) => T, allowNoResults: boolean): JerOperation<T> {
    if (isVerificationPage(html)) return { ok: false, classification: 'verification_page', error: new JerError('JER verification page', 'JER_VERIFICATION_PAGE') };
    try {
      const value = parse(html);
      return allowNoResults && value === null
        ? { ok: true, classification: 'valid_no_results', value: null }
        : { ok: true, classification: 'valid_results', value };
    }
    catch (error) {
      return { ok: false, classification: error instanceof JerHtmlStructureChangedError ? 'unknown_html' : 'provider_error', error: error instanceof JerError ? error : new ScrapedoProviderError() };
    }
  }
}

export interface ScrapedoRequestTransport { requestRaw(targetUrl: string, init: RequestInit, signal?: AbortSignal): Promise<ScrapedoRawResponse>; }
export interface ScrapedoSourceRuntime { runtime: ScrapedoRuntime<unknown>; progress: ProgressSupplier; transportFactory(attempt: SessionAttempt): ScrapedoRequestTransport; }
function operationError<T>(operation: Extract<JerOperation<T>, { ok: false }>, url: string): JerError {
  if (operation.classification === 'blocked') return new JerBlockedError('JER target returned HTTP 403', 403, url);
  if (operation.classification === 'rate_limited') return new JerRateLimitError('JER target returned HTTP 429', 429, url);
  return operation.error;
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
  startProviderRun?: (progress: ProgressSupplier) => Promise<{ runId: string; saveProgress(progress: ProgressWriteWithoutVersionTokenProviderState): Promise<void> }>;
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
      const discovered = await this.source.discover(options.signal); await this.repository.upsertGames(discovered); const games = requested ? discovered.filter(game => requested.includes(game.code)) : discovered; summary.gamesQueried = games.length; for (const game of games) { try { const dates = await this.source.dates(game.detailUrl, options.signal); const existing = new Set(await this.repository.existingDates(game.code, options.from, options.to)); const missing = dates.filter(date => (!options.from || date >= options.from) && (!options.to || date <= options.to) && !existing.has(date)); for (const date of missing) { summary.datesQueried++; try { const result = await this.source.historical(game, date, options.signal); if (result) { summary.resultsFound++; await recordResult(this.repository, result, summary); } else summary.resultsSkipped++; } catch (error) { if (options.signal?.aborted) throw error; summary.errors.push(`${game.code} ${date}: ${error instanceof Error ? error.message : String(error)}`); } } } catch (error) { if (options.signal?.aborted) throw error; summary.errors.push(`${game.code}: ${error instanceof Error ? error.message : String(error)}`); } } const status = summary.errors.length ? 'PARTIAL' : 'SUCCESS'; await this.repository.finishRun(runId, summary, status); return { id: runId, status, ...summary }; }
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
    const progressWrite = (): ProgressWriteWithoutVersionTokenProviderState => ({ attempted: progress.attempted, inserted: progress.inserted, updated: progress.updated, skipped: progress.skipped, failed: progress.failed, status: progress.status, nextPendingDate: progress.nextPendingDate });
    let providerSave: ((write: ProgressWriteWithoutVersionTokenProviderState) => Promise<void>) | undefined;
    let providerWriteFailed = false;
    const save = async (status: IngestionStatus, nextPendingDate?: string) => {
      progress.status = status; progress.nextPendingDate = nextPendingDate;
      if (!runId) throw new Error('Operational run was not initialized');
      if (providerSave) {
        try { await providerSave(progressWrite()); }
        catch (error) { providerWriteFailed = true; throw error; }
        return;
      }
      progress.version++; progress.requestToken = guard.nextRequestToken();
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
      if (guard.startProviderRun) {
        const providerRun = await guard.startProviderRun(progressWrite);
        runId = providerRun.runId;
        providerSave = providerRun.saveProgress;
      } else runId = await this.repository.startRun('BACKFILL', guard.ownerToken);
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
            if (!draw) { progress.skipped++; summary.resultsSkipped++; await save('RUNNING', nextPendingDate); continue; }
            summary.resultsFound++;
            let action: 'inserted' | 'updated' | 'skipped';
            try { action = await this.repository.upsertResult(draw); } catch (error) { throw new FatalBackfillError(messageOf(error)); }
            progress[action]++; summary[`results${action[0].toUpperCase()}${action.slice(1)}` as 'resultsInserted' | 'resultsUpdated' | 'resultsSkipped']++;
            await save('RUNNING', nextPendingDate);
          } catch (error) {
            if (error instanceof JerBlockedError) {
              let blockedError = error;
              if (providerSave && (this.source.canRetryScrapedoBlockedRequest?.() ?? true)) {
                try {
                  await ensure();
                  const replacement = await this.source.historical(item.game, item.date, controller.signal);
                  if (!replacement) { progress.skipped++; summary.resultsSkipped++; await save('RUNNING', nextPendingDate); continue; }
                  summary.resultsFound++;
                  const action = await this.repository.upsertResult(replacement);
                  progress[action]++; summary[`results${action[0].toUpperCase()}${action.slice(1)}` as 'resultsInserted' | 'resultsUpdated' | 'resultsSkipped']++;
                  await save('RUNNING', nextPendingDate);
                  continue;
                } catch (replacementError) {
                  if (!(replacementError instanceof JerBlockedError)) throw replacementError;
                  blockedError = replacementError;
                }
              }
              await guard.transition403(runId, { url: blockedError.url, status: 403, gameCode: item.game.code, date: item.date, error: blockedError.message, cooldownMs: guard.blockCooldownMs, nextPendingDate: item.date });
              return { id: runId, status: 'BLOCKED', sourceState: 'BLOCKED', ...summary };
            }
            if (error instanceof JerRateLimitError) {
              const cooldownMs = Math.max(error.retryAfterMs ?? 0, guard.rateLimitCooldownMs);
              await guard.transition429(runId, { url: error.url, status: 429, gameCode: item.game.code, date: item.date, error: error.message, cooldownMs, nextPendingDate: item.date });
              return { id: runId, status: 'PAUSED', sourceState: 'RATE_LIMITED', ...summary };
            }
            if (error instanceof ScrapedoProviderError) throw error;
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
      try { if (!providerWriteFailed) await save(status, progress.nextPendingDate); }
      catch (saveError) { summary.errors.push(messageOf(saveError)); }
      finally { if (runId) await this.repository.finishRun(runId, summary, status); }
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
