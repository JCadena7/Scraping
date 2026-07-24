import { DiscoveredGame, NormalizedDrawResult, assertDate } from './domain.js';
import { JerHttpClient } from './http-client.js';
import { JerHistoryParser } from './history-parser.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository, RunSummary } from './repository.js';

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
  async execute(signal?: AbortSignal): Promise<RunSummary> {
    const runId = await this.repository.startRun('LATEST'); const summary = emptySummary();
    try { const snapshot = await this.source.mainSnapshot(signal); summary.gamesQueried = snapshot.games.length; await this.repository.upsertGames(snapshot.games); summary.resultsFound = snapshot.latest.results.length; summary.errors.push(...snapshot.latest.rejected.map(item => `row ${item.row}: ${item.reason}`)); for (const result of snapshot.latest.results) await recordResult(this.repository, result, summary); const status = summary.errors.length ? 'PARTIAL' : 'SUCCESS'; await this.repository.finishRun(runId, summary, status); return { id: runId, status, ...summary }; }
    catch (error) { summary.errors.push(error instanceof Error ? error.message : String(error)); await this.repository.finishRun(runId, summary, 'FAILED'); return { id: runId, status: 'FAILED', ...summary }; }
  }
}

export interface BackfillOptions { games?: string[]; from?: string; to?: string; signal?: AbortSignal; }
export class BackfillJerResultsUseCase {
  constructor(private readonly source: JerSource, private readonly repository: DrawRepository) {}
  async execute(options: BackfillOptions = {}): Promise<RunSummary> {
    if (options.from) assertDate(options.from); if (options.to) assertDate(options.to); const runId = await this.repository.startRun('BACKFILL'); const summary = emptySummary();
    try { const discovered = await this.source.discover(options.signal); await this.repository.upsertGames(discovered); const games = options.games?.length ? discovered.filter(game => options.games?.includes(game.code)) : discovered; summary.gamesQueried = games.length; for (const game of games) { try { const dates = await this.source.dates(game.detailUrl, options.signal); const existing = new Set(await this.repository.existingDates(game.code, options.from, options.to)); const missing = dates.filter(date => (!options.from || date >= options.from) && (!options.to || date <= options.to) && !existing.has(date)); for (const date of missing) { summary.datesQueried++; try { const result = await this.source.historical(game, date, options.signal); summary.resultsFound++; await recordResult(this.repository, result, summary); } catch (error) { summary.errors.push(`${game.code} ${date}: ${error instanceof Error ? error.message : String(error)}`); } } } catch (error) { summary.errors.push(`${game.code}: ${error instanceof Error ? error.message : String(error)}`); } } const status = summary.errors.length ? 'PARTIAL' : 'SUCCESS'; await this.repository.finishRun(runId, summary, status); return { id: runId, status, ...summary }; }
    catch (error) { summary.errors.push(error instanceof Error ? error.message : String(error)); await this.repository.finishRun(runId, summary, 'FAILED'); return { id: runId, status: 'FAILED', ...summary }; }
  }
}

function emptySummary() { return { gamesQueried: 0, datesQueried: 0, resultsFound: 0, resultsInserted: 0, resultsUpdated: 0, resultsSkipped: 0, errors: [] as string[] }; }
async function recordResult(repository: DrawRepository, result: NormalizedDrawResult, summary: ReturnType<typeof emptySummary>) { try { const action = await repository.upsertResult(result); summary[`results${action[0].toUpperCase()}${action.slice(1)}` as 'resultsInserted' | 'resultsUpdated' | 'resultsSkipped']++; } catch (error) { summary.errors.push(error instanceof Error ? error.message : String(error)); } }
