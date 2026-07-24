import { describe, expect, it } from 'vitest';
import { JerHistoryParser } from '../src/jer/history-parser.js';
import { JerHtmlStructureChangedError, JerInvalidResultError, validateNormalizedResult } from '../src/jer/domain.js';
import { ambiguousHistoricalSibling, historicalAstroCurrentLayout, historicalAstroCurrentLayoutWithConflictingSigns, historicalAstroSibling, historicalLotterySibling, missingHistoricalSibling } from './fixtures.js';

const sourceUrl = 'https://jer.example.test/resultados/game/';
const historical = new JerHistoryParser();

function game(type: 'LOTTERY' | 'CHANCE' | 'ASTRO' | 'DUPLA' | 'OTHER') {
  return { code: `${type}_TEST`, name: `${type} Test`, type, detailUrl: sourceUrl, active: true };
}

describe('bounded historical result parsing', () => {
  it('binds Astro heading, baloteras, and sign inside one sibling result region', () => {
    const result = historical.parse(historicalAstroSibling, game('ASTRO'), '2026-07-23', sourceUrl);
    expect(result.winningNumber).toBe('0074');
    expect(result.zodiacSign).toBe('PISCIS');
  });

  it('parses the current bounded Astro sibling layout without crossing into page content', () => {
    const result = historical.parse(historicalAstroCurrentLayout, game('ASTRO'), '2026-07-23', sourceUrl);
    expect(result.winningNumber).toBe('3961');
    expect(result.zodiacSign).toBe('SAGITARIO');
  });

  it('rejects conflicting Astro signs in the bounded sibling region', () => {
    expect(() => historical.parse(historicalAstroCurrentLayoutWithConflictingSigns, game('ASTRO'), '2026-07-23', sourceUrl)).toThrow(JerHtmlStructureChangedError);
  });

  it('binds lottery digits and a series sibling outside cajonconquinta', () => {
    const result = historical.parse(historicalLotterySibling, game('LOTTERY'), '2026-07-23', sourceUrl);
    expect(result.winningNumber).toBe('0017');
    expect(result.fifthDigit).toBe('9');
    expect(result.series).toBe('AB12');
  });

  it('rejects ambiguous or missing bounded result associations', () => {
    expect(() => historical.parse(ambiguousHistoricalSibling, game('ASTRO'), '2026-07-23', sourceUrl)).toThrow(JerHtmlStructureChangedError);
    expect(() => historical.parse(missingHistoricalSibling, game('ASTRO'), '2026-07-23', sourceUrl)).toThrow(JerHtmlStructureChangedError);
  });
});

describe('strict normalized result validation', () => {
  it.each(['LOTTERY', 'CHANCE', 'ASTRO', 'DUPLA'] as const)('accepts exactly four digits for %s, including leading zeroes', type => {
    expect(validateNormalizedResult({ gameType: type, winningNumber: '0017', fifthDigit: null })).toEqual({ gameType: type, winningNumber: '0017', fifthDigit: null });
  });

  it.each(['123', '12345'])('rejects non-four-digit results', winningNumber => {
    expect(() => validateNormalizedResult({ gameType: 'LOTTERY', winningNumber, fifthDigit: null })).toThrow(JerInvalidResultError);
  });

  it('fails closed for OTHER game types', () => {
    expect(() => validateNormalizedResult({ gameType: 'OTHER', winningNumber: '0017', fifthDigit: null })).toThrow(JerInvalidResultError);
  });
});
