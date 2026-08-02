import type { SupabaseClient } from '@supabase/supabase-js';
import { DiscoveredGame, IngestionStatus, NormalizedDrawResult } from './domain.js';
import { canonicalResultHash } from './hash.js';
import type { ProviderStateV1 } from './session-policy.js';

export interface JerProgressWrite { ownerToken: string; version: number; requestToken: string; attempted: number; inserted: number; updated: number; skipped: number; failed: number; status: string; nextPendingDate?: string; }
export interface JerProviderProgressWrite extends JerProgressWrite { providerState: ProviderStateV1; }
export interface JerProviderProgressReceipt { accepted: boolean; duplicate: boolean; runId: string; version: number; requestToken: string; providerState: ProviderStateV1; }
export interface ScrapedoBackfillRun { runId: string; providerState: ProviderStateV1 | undefined; version: number; requestToken: string; }

export interface UpsertCounts { inserted: number; updated: number; skipped: number; }
export interface RunSummary { id: string; status: IngestionStatus; sourceState?: 'ACTIVE' | 'RATE_LIMITED' | 'BLOCKED' | 'DISABLED'; gamesQueried: number; datesQueried: number; resultsFound: number; resultsInserted: number; resultsUpdated: number; resultsSkipped: number; errors: string[]; }
export interface JerLeaseResult { acquired: boolean; state: 'ACTIVE' | 'RATE_LIMITED' | 'BLOCKED' | 'DISABLED'; cooldownUntil?: string | null; leaseExpiresAt?: string | null; version: number; }
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
  async acquireJerLease(ownerToken: string, leaseDurationMs: number): Promise<JerLeaseResult> {
    const { data, error } = await this.client.rpc('jer_acquire_and_gate', { p_owner_token: ownerToken, p_lease_duration_ms: leaseDurationMs });
    if (error) throw new Error(`Could not acquire JER lease: ${error.message}`);
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row || typeof row.acquired !== 'boolean' || !['ACTIVE', 'RATE_LIMITED', 'BLOCKED', 'DISABLED'].includes(row.state as string) || typeof row.version !== 'number') throw new Error('Could not acquire JER lease: invalid RPC response');
    return { acquired: row.acquired, state: row.state as JerLeaseResult['state'], cooldownUntil: row.cooldown_until as string | null | undefined, leaseExpiresAt: row.lease_expires_at as string | null | undefined, version: row.version };
  }
  async renewJerLease(ownerToken: string, leaseDurationMs: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('jer_renew_lease', { p_owner_token: ownerToken, p_lease_duration_ms: leaseDurationMs });
    if (error) throw new Error(`Could not renew JER lease: ${error.message}`);
    if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.renewed !== 'boolean') throw new Error('Could not renew JER lease: invalid RPC response');
    return data[0].renewed;
  }
  async releaseJerLease(ownerToken: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('jer_release_lease', { p_owner_token: ownerToken });
    if (error) throw new Error(`Could not release JER lease: ${error.message}`);
    if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.released !== 'boolean') throw new Error('Could not release JER lease: invalid RPC response');
    return data[0].released;
  }
  async saveJerProgress(runId: string, write: JerProgressWrite): Promise<{ accepted: boolean; duplicate: boolean; version: number }> {
    const { data, error } = await this.client.rpc('jer_save_progress', { p_run_id: runId, p_owner_token: write.ownerToken, p_version: write.version, p_request_token: write.requestToken, p_status: write.status, p_attempted: write.attempted, p_inserted: write.inserted, p_updated: write.updated, p_skipped: write.skipped, p_failed: write.failed, p_next_pending_date: write.nextPendingDate ?? null });
    if (error) throw new Error(`Could not save JER progress: ${error.message}`);
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row || typeof row.accepted !== 'boolean' || typeof row.duplicate !== 'boolean' || typeof row.version !== 'number') throw new Error('Could not save JER progress: invalid RPC response');
    return row;
  }
  async startOrResumeScrapedoBackfill(ownerToken: string): Promise<ScrapedoBackfillRun> {
    const { data, error } = await this.client.rpc('jer_start_or_resume_scrapedo_backfill', { p_owner_token: ownerToken });
    if (error) throw new Error(`Could not start or resume Scrape.do backfill: ${error.message}`);
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row || typeof row.run_id !== 'string' || typeof row.version !== 'number' || typeof row.request_token !== 'string' || (row.provider_state !== null && !isProviderStateV1(row.provider_state))) throw new Error('Could not start or resume Scrape.do backfill: invalid RPC response');
    return { runId: row.run_id, providerState: row.provider_state ?? undefined, version: row.version, requestToken: row.request_token };
  }
  async saveJerProgressWithProviderState(runId: string, write: JerProviderProgressWrite): Promise<JerProviderProgressReceipt> {
    if (!isProviderStateV1(write.providerState)) throw new Error('Invalid Scrape.do provider state');
    const { data, error } = await this.client.rpc('jer_save_progress_with_provider_state', {
      p_run_id: runId, p_owner_token: write.ownerToken, p_version: write.version, p_request_token: write.requestToken,
      p_status: write.status, p_attempted: write.attempted, p_inserted: write.inserted, p_updated: write.updated,
      p_skipped: write.skipped, p_failed: write.failed, p_next_pending_date: write.nextPendingDate ?? null, p_provider_state: write.providerState,
    });
    if (error) throw new Error(`Could not save JER progress with provider state: ${error.message}`);
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row || typeof row.accepted !== 'boolean' || typeof row.duplicate !== 'boolean' || typeof row.run_id !== 'string' || typeof row.version !== 'number' || typeof row.request_token !== 'string' || !isProviderStateV1(row.provider_state)) throw new Error('Could not save JER progress with provider state: invalid RPC response');
    return { accepted: row.accepted, duplicate: row.duplicate, runId: row.run_id, version: row.version, requestToken: row.request_token, providerState: row.provider_state };
  }
  async transitionJer403(ownerToken: string, runId: string | undefined, cooldownMs: number, errorText: string): Promise<boolean> { return this.transitionJer('jer_transition_403', ownerToken, runId, cooldownMs, errorText); }
  async transitionJer429(ownerToken: string, runId: string | undefined, cooldownMs: number, errorText: string): Promise<boolean> { return this.transitionJer('jer_transition_429', ownerToken, runId, cooldownMs, errorText); }
  private async transitionJer(rpcName: 'jer_transition_403' | 'jer_transition_429', ownerToken: string, runId: string | undefined, cooldownMs: number, errorText: string): Promise<boolean> {
    const { data, error } = await this.client.rpc(rpcName, { p_owner_token: ownerToken, p_run_id: runId ?? null, p_cooldown_ms: cooldownMs, p_error: errorText });
    if (error) throw new Error(`Could not transition JER source: ${error.message}`);
    if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.transitioned !== 'boolean') throw new Error('Could not transition JER source: invalid RPC response');
    return data[0].transitioned;
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
  async startRun(runType: string, ownerToken?: string): Promise<string> { const { data, error } = await this.client.from('draw_ingestion_runs').insert({ run_type: runType, status: 'RUNNING', ...(ownerToken ? { owner_token: ownerToken } : {}) }).select('id').single(); if (error) throw new Error(`Could not start ingestion run: ${error.message}`); return data.id as string; }
  async finishRun(id: string, summary: Omit<RunSummary, 'id' | 'status'>, status: IngestionStatus): Promise<void> { const { error } = await this.client.from('draw_ingestion_runs').update({ finished_at: new Date().toISOString(), status, games_queried: summary.gamesQueried, dates_queried: summary.datesQueried, results_found: summary.resultsFound, results_inserted: summary.resultsInserted, results_updated: summary.resultsUpdated, results_skipped: summary.resultsSkipped, errors: summary.errors }).eq('id', id); if (error) throw new Error(`Could not finish ingestion run: ${error.message}`); }
}

function isProviderStateV1(value: unknown): value is ProviderStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const expected = ['pendingSuper', 'provider', 'schemaVersion', 'sessionId', 'sessionStatus', 'standardBlockedSessionCount', 'targetOrigin', 'tier'];
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && state.schemaVersion === 1
    && state.provider === 'SCRAPEDO'
    && state.targetOrigin === 'https://jer.com.co'
    && (state.tier === 'STANDARD' || state.tier === 'SUPER')
    && (state.sessionStatus === 'ACTIVE' || state.sessionStatus === 'INVALID')
    && Number.isInteger(state.standardBlockedSessionCount) && (state.standardBlockedSessionCount as number) >= 0
    && typeof state.pendingSuper === 'boolean'
    && (state.sessionId === null
      ? state.tier === 'STANDARD' && state.sessionStatus === 'INVALID' && state.standardBlockedSessionCount === 0 && state.pendingSuper === false
      : Number.isInteger(state.sessionId) && (state.sessionId as number) >= 0 && (state.sessionId as number) <= 1_000_000);
}
