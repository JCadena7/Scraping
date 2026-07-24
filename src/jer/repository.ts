import type { SupabaseClient } from '@supabase/supabase-js';
import { DiscoveredGame, IngestionStatus, NormalizedDrawResult } from './domain.js';
import { canonicalResultHash } from './hash.js';

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
  async listGames(): Promise<DiscoveredGame[]> { const { data, error } = await this.client.from('draw_games').select('external_code,name,type,detail_url,active').eq('source', 'jer').eq('active', true); if (error) throw new Error(`Could not read JER catalog: ${error.message}`); return (data ?? []).map(row => ({ code: row.external_code as string, name: row.name as string, type: row.type as DiscoveredGame['type'], detailUrl: row.detail_url as string, active: row.active as boolean })); }
  async getGame(code: string): Promise<(DiscoveredGame & { id: string }) | undefined> { const { data, error } = await this.client.from('draw_games').select('id,external_code,name,type,detail_url,active').eq('external_code', code).maybeSingle(); if (error) throw new Error(`Could not read game ${code}: ${error.message}`); if (!data) return undefined; const row = data as GameRow; return { id: row.id, code: row.external_code, name: row.name, type: row.type, detailUrl: row.detail_url, active: row.active }; }
  async existingDates(gameCode: string, from?: string, to?: string): Promise<string[]> { const game = await this.getGame(gameCode); if (!game) return []; let query = this.client.from('draw_results').select('draw_date').eq('game_id', game.id); if (from) query = query.gte('draw_date', from); if (to) query = query.lte('draw_date', to); const { data, error } = await query; if (error) throw new Error(`Could not read existing dates for ${gameCode}: ${error.message}`); return (data ?? []).map(row => row.draw_date as string); }
  async upsertResult(result: NormalizedDrawResult): Promise<'inserted' | 'updated' | 'skipped'> {
    const prepared = await this.enrichDrawNumber(result);
    const { data, error } = await this.client.rpc('upsert_draw_result', {
      p_game_code: prepared.gameCode, p_draw_date: prepared.drawDate, p_draw_number: prepared.drawNumber ?? null,
      p_winning_number: prepared.winningNumber, p_fifth_digit: prepared.fifthDigit ?? null, p_series: prepared.series ?? null,
      p_zodiac_sign: prepared.zodiacSign ?? null, p_source_url: prepared.sourceUrl, p_source_hash: prepared.sourceHash,
      p_fetched_at: prepared.fetchedAt.toISOString(), p_verified: prepared.verified,
    });
    if (error) throw new Error(`Could not persist result ${result.gameCode}/${result.drawDate}: ${error.message}`);
    const action = Array.isArray(data) && data.length === 1 ? data[0]?.action : undefined;
    if (!['inserted', 'updated', 'skipped', 'rebaselined'].includes(action)) throw new Error(`Could not persist result ${result.gameCode}/${result.drawDate}: invalid RPC action`);
    return action === 'rebaselined' ? 'skipped' : action;
  }
  private async enrichDrawNumber(result: NormalizedDrawResult): Promise<NormalizedDrawResult> {
    if (result.drawNumber != null) return result;
    const game = await this.getGame(result.gameCode);
    if (!game) return result;
    const { data, error } = await this.client.from('draw_results').select('draw_number').eq('game_id', game.id).eq('draw_date', result.drawDate).maybeSingle();
    if (error) throw new Error(`Could not read existing result ${result.gameCode}/${result.drawDate}: ${error.message}`);
    if (data?.draw_number == null) return result;
    const drawNumber = data.draw_number as string;
    return { ...result, drawNumber, sourceHash: canonicalResultHash({ ...result, drawNumber }) };
  }
  async startRun(runType: string): Promise<string> { const { data, error } = await this.client.from('draw_ingestion_runs').insert({ run_type: runType, status: 'RUNNING' }).select('id').single(); if (error) throw new Error(`Could not start ingestion run: ${error.message}`); return data.id as string; }
  async finishRun(id: string, summary: Omit<RunSummary, 'id' | 'status'>, status: IngestionStatus): Promise<void> { const { error } = await this.client.from('draw_ingestion_runs').update({ finished_at: new Date().toISOString(), status, games_queried: summary.gamesQueried, dates_queried: summary.datesQueried, results_found: summary.resultsFound, results_inserted: summary.resultsInserted, results_updated: summary.resultsUpdated, results_skipped: summary.resultsSkipped, errors: summary.errors }).eq('id', id); if (error) throw new Error(`Could not finish ingestion run: ${error.message}`); }
}
