import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DiscoveredGame, JerDateMismatchError, JerHtmlStructureChangedError, JerResultNotFoundError, NormalizedDrawResult, assertDate, normalizeSign, normalizeText } from './domain.js';
import { sourceHash } from './hash.js';

export class JerHistoryParser {
  getDates(html: string): string[] {
    const $ = cheerio.load(html); const select = $('select[name="fecha"]'); if (!select.length) throw new JerHtmlStructureChangedError('Date selector select[name="fecha"] was not found');
    return [...new Set(select.find('option').map((_, option) => $(option).attr('value') ?? '').get().filter(value => { try { assertDate(value); return true; } catch { return false; } }))].sort();
  }

  parse(html: string, game: DiscoveredGame, requestedDate: string, sourceUrl: string, fetchedAt = new Date()): NormalizedDrawResult {
    assertDate(requestedDate); const $ = cheerio.load(html); const container = $('.cajonconquinta, .cajonsinquinta, .resultado-sorteo').first(); if (!container.length) throw new JerResultNotFoundError(`No result container found for ${game.code}`);
    const heading = normalizeText(container.find('h4, h3, .tituloresultado').first().text()) || normalizeText($('h4, h3').first().text()); const dateMatch = heading.match(/Resultado\s+(\d{4}-\d{2}-\d{2})/i); const drawDate = dateMatch?.[1];
    if (!drawDate) throw new JerHtmlStructureChangedError(`Result date missing for ${game.code}`); if (drawDate !== requestedDate) throw new JerDateMismatchError(requestedDate, drawDate);
    const fifthNode = container.find('.colorquinta, .quinta').first(); const fifthDigit = fifthNode.length ? normalizeText(fifthNode.text()) : null;
    const nodes = container.find('.balotera-home-interno, .balotera-home').toArray().filter(node => !$(node).hasClass('colorquinta') && !$(node).hasClass('quinta')); const winningNumber = nodes.map(node => normalizeText($(node).text())).join('');
    if (!/^\d+$/.test(winningNumber)) throw new JerHtmlStructureChangedError(`Invalid number for ${game.code}: ${winningNumber}`); if (fifthDigit !== null && !/^\d$/.test(fifthDigit)) throw new JerHtmlStructureChangedError(`Invalid fifth digit for ${game.code}`);
    const series = normalizeText(container.find('.serie, .colorserie').first().text()) || readLabeled($, container, /serie/i); const zodiac = normalizeText(container.find('.signo, .signozodiacal').first().text()) || readLabeled($, container, /signo|zodiac/i); const drawNumber = readLabeled($, container, /sorteo|draw/i);
    return { gameCode: game.code, gameName: game.name, gameType: game.type, drawDate, drawNumber: drawNumber || null, winningNumber, fifthDigit, series: series || null, zodiacSign: zodiac ? normalizeSign(zodiac) : null, sourceUrl, fetchedAt, sourceHash: sourceHash(html), verified: true };
  }
}
function readLabeled($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, label: RegExp): string { let result = ''; root.find('*').each((_, node) => { if (result) return; const text = normalizeText($(node).text()); if (label.test(text) && text.length < 100) result = text.replace(label, '').replace(/[:\-]/, '').trim(); }); return result; }
