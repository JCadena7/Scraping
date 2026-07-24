import type { SupabaseClient } from '@supabase/supabase-js';
import { DiscoveredGame, IngestionStatus, NormalizedDrawResult } from './domain.js';

export interface UpsertCounts { inserted: number; updated: number; skipped: number; }
export interface RunSummary { id: string; status: IngestionStatus; gamesQueried: number; datesQueried: number; resultsFound: number; resultsInserted: number; resultsUpdated: number; resultsSkipped: number; errors: string[]; }
type GameRow = { id: string; external_code: string; name: string; type: DiscoveredGame['type']; detail_url: string; active: boolean };

export class DrawRepository {
  constructor(private readonly client: SupabaseClient) {}

  async upsertGame(game: DiscoveredGame): Promise<string> {
    const { data, error } = await this.client.from('draw_games').upsert({ external_code: game.code, name: game.name, type: game.type, detail_url: game.detailUrl, source: 'jer', active: game.active }, { onConflict: 'external_code' }).select('id').single();
    if (error) throw new Error(`Could not upsert game ${game.code}: ${error.message}`);
    return data.id as string;
  }
  async upsertGames(games: DiscoveredGame[]): Promise<void> { if (!games.length) return; const { error } = await this.client.from('draw_games').upsert(games.map(game => ({ external_code: game.code, name: game.name, type: game.type, detail_url: game.detailUrl, source: 'jer', active: game.active })), { onConflict: 'external_code' }); if (error) throw new Error(`Could not update JER catalog: ${error.message}`); }
  async getGame(code: string): Promise<(DiscoveredGame & { id: string }) | undefined> { const { data, error } = await this.client.from('draw_games').select('id,external_code,name,type,detail_url,active').eq('external_code', code).maybeSingle(); if (error) throw new Error(`Could not read game ${code}: ${error.message}`); if (!data) return undefined; const row = data as GameRow; return { id: row.id, code: row.external_code, name: row.name, type: row.type, detailUrl: row.detail_url, active: row.active }; }
  async existingDates(gameCode: string, from?: string, to?: string): Promise<string[]> { const game = await this.getGame(gameCode); if (!game) return []; let query = this.client.from('draw_results').select('draw_date').eq('game_id', game.id); if (from) query = query.gte('draw_date', from); if (to) query = query.lte('draw_date', to); const { data, error } = await query; if (error) throw new Error(`Could not read existing dates for ${gameCode}: ${error.message}`); return (data ?? []).map(row => row.draw_date as string); }
  async upsertResult(result: NormalizedDrawResult): Promise<'inserted' | 'updated' | 'skipped'> {
    const game = await this.getGame(result.gameCode); if (!game) throw new Error(`Game not found in catalog: ${result.gameCode}`);
    const { data: existing, error: readError } = await this.client.from('draw_results').select('id,source_hash,winning_number').eq('game_id', game.id).eq('draw_date', result.drawDate).maybeSingle(); if (readError) throw new Error(`Could not read result ${result.gameCode}/${result.drawDate}: ${readError.message}`);
    if (!existing) { const { error } = await this.client.from('draw_results').insert(toRow(result, game.id)); if (error) throw new Error(`Could not insert result: ${error.message}`); return 'inserted'; }
    if (existing.source_hash === result.sourceHash) return 'skipped';
    const { error: auditError } = await this.client.from('draw_result_changes').insert({ result_id: existing.id, previous_hash: existing.source_hash, previous_winning_number: existing.winning_number, new_hash: result.sourceHash, new_winning_number: result.winningNumber }); if (auditError) throw new Error(`Could not audit result change: ${auditError.message}`);
    const { error } = await this.client.from('draw_results').update(toRow(result, game.id)).eq('id', existing.id); if (error) throw new Error(`Could not update result: ${error.message}`); return 'updated';
  }
  async startRun(runType: string): Promise<string> { const { data, error } = await this.client.from('draw_ingestion_runs').insert({ run_type: runType, status: 'RUNNING' }).select('id').single(); if (error) throw new Error(`Could not start ingestion run: ${error.message}`); return data.id as string; }
  async finishRun(id: string, summary: Omit<RunSummary, 'id' | 'status'>, status: IngestionStatus): Promise<void> { const { error } = await this.client.from('draw_ingestion_runs').update({ finished_at: new Date().toISOString(), status, games_queried: summary.gamesQueried, dates_queried: summary.datesQueried, results_found: summary.resultsFound, results_inserted: summary.resultsInserted, results_updated: summary.resultsUpdated, results_skipped: summary.resultsSkipped, errors: summary.errors }).eq('id', id); if (error) throw new Error(`Could not finish ingestion run: ${error.message}`); }
}

function toRow(result: NormalizedDrawResult, gameId: string) { return { game_id: gameId, draw_date: result.drawDate, draw_number: result.drawNumber ?? null, winning_number: result.winningNumber, fifth_digit: result.fifthDigit ?? null, series: result.series ?? null, zodiac_sign: result.zodiacSign ?? null, source_url: result.sourceUrl, source_hash: result.sourceHash, fetched_at: result.fetchedAt.toISOString(), verified: result.verified }; }
