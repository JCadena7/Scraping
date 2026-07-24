import { describe, expect, it } from 'vitest';
import { JerHistoryParser } from '../src/jer/history-parser.js';
import { JerMainPageParser } from '../src/jer/main-page-parser.js';
import { JerDateMismatchError, JerHtmlStructureChangedError } from '../src/jer/domain.js';
import { historyWithFifth, historyWithoutFifth, invalidHistory, mainHtml } from './fixtures.js';

const parser = new JerMainPageParser('https://jer.com.co');
describe('JER parsers', () => {
  it('discovers and classifies all links using stable slugs', () => { const games = parser.parseGames(mainHtml); expect(games.map(game => game.code)).toEqual(['RESULTADOS_SORTEO_ANTIOQUENITA_DIA', 'CHONTICO_DIA', 'ASTRO_SOL', 'DUPLA']); expect(games.map(game => game.type)).toEqual(['CHANCE', 'CHANCE', 'ASTRO', 'DUPLA']); });
  it('parses table headers and preserves leading zeroes', () => { const games = parser.parseGames(mainHtml); const parsed = parser.parseLatest(mainHtml, games); expect(parsed.rejected).toEqual([]); expect(parsed.results[0].winningNumber).toBe('0017'); expect(parsed.results[0].fifthDigit).toBe('9'); expect(parsed.results[0].series).toBe('AB12'); expect(parsed.results[1].drawDate).toBe('2026-07-23'); });
  it('parses historical fifth and numbers without fifth', () => { const history = new JerHistoryParser(); const game = { code: 'ANTIOQUENITA_DIA', name: 'Antioqueñita Día', type: 'CHANCE' as const, detailUrl: 'https://jer.com.co/resultados/antioquenita/', active: true }; expect(history.getDates(historyWithFifth)).toEqual(['2026-07-23']); expect(history.parse(historyWithFifth, game, '2026-07-23', game.detailUrl).winningNumber).toBe('3992'); expect(history.parse(historyWithFifth, game, '2026-07-23', game.detailUrl).fifthDigit).toBe('9'); expect(history.parse(historyWithoutFifth, { ...game, code: 'DUPLA' }, '2026-07-23', game.detailUrl).winningNumber).toBe('0017'); });
  it('rejects malformed and mismatched historical responses', () => { const history = new JerHistoryParser(); const game = { code: 'X', name: 'X', type: 'OTHER' as const, detailUrl: 'https://jer.com.co/resultados/x/', active: true }; expect(() => history.parse(invalidHistory, game, '2026-07-23', game.detailUrl)).toThrow(JerHtmlStructureChangedError); expect(() => history.parse(historyWithFifth, game, '2026-07-22', game.detailUrl)).toThrow(JerDateMismatchError); });
});
