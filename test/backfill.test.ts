import { describe, expect, it, vi } from 'vitest';
import { BackfillJerResultsUseCase, JerSource } from '../src/jer/use-cases.js';
import type { DrawRepository } from '../src/jer/repository.js';

describe('JER backfill', () => {
  it('omits dates already stored and queries only missing dates', async () => {
    const game = { code: 'X', name: 'X', type: 'CHANCE' as const, detailUrl: 'https://jer.com.co/resultados/x/', active: true };
    const historical = vi.fn(async () => ({ gameCode: 'X', gameName: 'X', gameType: 'CHANCE' as const, drawDate: '2026-07-24', winningNumber: '1234', sourceUrl: game.detailUrl, sourceHash: 'x', fetchedAt: new Date(), verified: true }));
    const source = { discover: vi.fn(async () => [game]), dates: vi.fn(async () => ['2026-07-23', '2026-07-24']), historical, mainSnapshot: vi.fn() } as unknown as JerSource;
    const repository = { startRun: vi.fn(async () => 'run'), upsertGames: vi.fn(async () => undefined), existingDates: vi.fn(async () => ['2026-07-23']), upsertResult: vi.fn(async () => 'inserted'), finishRun: vi.fn(async () => undefined) } as unknown as DrawRepository;
    const summary = await new BackfillJerResultsUseCase(source, repository).execute();
    expect(historical).toHaveBeenCalledTimes(1); expect(historical).toHaveBeenCalledWith(game, '2026-07-24', undefined); expect(summary.resultsInserted).toBe(1);
  });
});
