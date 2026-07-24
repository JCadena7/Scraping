import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DiscoveredGame, JerDateMismatchError, JerHtmlStructureChangedError, NormalizedDrawResult, assertDate, normalizeSign, normalizeText, validateNormalizedResult } from './domain.js';
import { canonicalResultHash } from './hash.js';

export class JerHistoryParser {
  getDates(html: string): string[] {
    const $ = cheerio.load(html); const select = $('select[name="fecha"]'); if (!select.length) throw new JerHtmlStructureChangedError('Date selector select[name="fecha"] was not found');
    return [...new Set(select.find('option').map((_, option) => $(option).attr('value') ?? '').get().filter(value => { try { assertDate(value); return true; } catch { return false; } }))].sort();
  }

  parse(html: string, game: DiscoveredGame, requestedDate: string, sourceUrl: string, fetchedAt = new Date()): NormalizedDrawResult {
    assertDate(requestedDate);
    const $ = cheerio.load(html);
    const root = boundedResultRoot($, requestedDate, game.code);
    const resultRegion = game.type === 'ASTRO' ? boundedAstroRegion($, root, game) : root;
    const digitContainer = boundedDigitContainer($, resultRegion, game);
    const fifthNodes = digitContainer.find('.colorquinta, .quinta').toArray();
    if (fifthNodes.length > 1) throw new JerHtmlStructureChangedError(`Ambiguous fifth digit for ${game.code}`);
    const fifthDigit = fifthNodes.length ? normalizeText($(fifthNodes[0]).text()) : null;
    const winningNumber = digitContainer.find('.balotera-home-interno, .balotera-home').toArray()
      .filter(node => !$(node).hasClass('colorquinta') && !$(node).hasClass('quinta'))
      .map(node => normalizeText($(node).text())).join('');
    const series = readBoundedValue($, resultRegion, '.serie, .colorserie', /serie/i);
    const zodiac = readBoundedValue($, resultRegion, '.signo, .signozodiacal', /signo|zodiac/i);
    if (game.type === 'ASTRO' && !zodiac) throw new JerHtmlStructureChangedError(`Astro sign missing for ${game.code}`);
    const drawNumber = readBoundedValue($, root, '.sorteo, .draw', /sorteo|draw/i);
    const result = validateNormalizedResult({ gameCode: game.code, gameName: game.name, gameType: game.type, drawDate: requestedDate, drawNumber: drawNumber || null, winningNumber, fifthDigit, series: series || null, zodiacSign: zodiac ? normalizeSign(zodiac) : null, sourceUrl, fetchedAt, sourceHash: '', verified: true });
    return { ...result, sourceHash: canonicalResultHash(result) };
  }
}

function boundedResultRoot($: cheerio.CheerioAPI, requestedDate: string, gameCode: string): cheerio.Cheerio<AnyNode> {
  const datedHeadings = $('h4, h3, .tituloresultado').toArray().flatMap(node => {
    const match = normalizeText($(node).text()).match(/^Resultado\s+(\d{4}-\d{2}-\d{2})$/i);
    return match ? [{ node, date: match[1] }] : [];
  });
  const headings = datedHeadings.filter(({ date }) => date === requestedDate).map(({ node }) => node);
  if (headings.length === 0 && datedHeadings.length === 1) throw new JerDateMismatchError(requestedDate, datedHeadings[0].date);
  if (headings.length === 0) throw new JerHtmlStructureChangedError(`Result date missing for ${gameCode}`);
  if (headings.length > 1) throw new JerHtmlStructureChangedError(`Ambiguous result heading for ${gameCode}`);
  const heading = $(headings[0]);
  const root = heading.closest('section, article, .resultado-historico, .cajonconquinta, .cajonsinquinta, .resultado-sorteo').first();
  return root.length ? root : heading.parent();
}

function boundedDigitContainer($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, game: DiscoveredGame): cheerio.Cheerio<AnyNode> {
  const selector = game.type === 'ASTRO' ? '.baloteras, .cajon-baloteras' : '.cajonconquinta, .cajonsinquinta, .resultado-sorteo';
  const candidates = [...root.filter(selector).toArray(), ...root.find(selector).toArray()]
    .filter(node => $(node).find('.balotera-home-interno, .balotera-home').length > 0);
  if (candidates.length !== 1) throw new JerHtmlStructureChangedError(`${candidates.length ? 'Ambiguous' : 'Missing'} bounded digit container for ${game.code}`);
  return $(candidates[0]);
}

function boundedAstroRegion($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, game: DiscoveredGame): cheerio.Cheerio<AnyNode> {
  if (root.find('.baloteras, .cajon-baloteras').length) return root;
  const siblings = root.nextAll().toArray().slice(0, 2);
  if (siblings.some(node => $(node).is('table, form, footer') || $(node).find('table, form, footer').length)) {
    throw new JerHtmlStructureChangedError(`Unsafe Astro sibling boundary for ${game.code}`);
  }
  const region = $(siblings);
  const digits = region.find('.baloteras, .cajon-baloteras').toArray()
    .filter(node => $(node).find('.balotera-home-interno, .balotera-home').length > 0);
  const signs = labeledBoundedValues($, region, /signo|zodiac/i);
  if (digits.length !== 1 || signs.length !== 1) {
    throw new JerHtmlStructureChangedError(`${digits.length ? 'Ambiguous' : 'Missing'} bounded Astro sibling result for ${game.code}`);
  }
  return region;
}

function readBoundedValue($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, selector: string, label: RegExp): string {
  const classMatches = boundedValues($, root, selector, label);
  if (classMatches.length > 1) throw new JerHtmlStructureChangedError('Ambiguous bounded result metadata');
  if (classMatches.length === 1) return classMatches[0];
  const labeled = labeledBoundedValues($, root, label);
  if (labeled.length > 1) throw new JerHtmlStructureChangedError('Ambiguous bounded result metadata');
  return labeled[0] ?? '';
}

function boundedValues($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, selector: string, label: RegExp): string[] {
  return [...root.filter(selector).toArray(), ...root.find(selector).toArray()]
    .map(node => labeledValue(normalizeText($(node).text()), label)).filter(Boolean);
}

function labeledBoundedValues($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, label: RegExp): string[] {
  return [...root.filter('*').toArray().filter(node => $(node).children().length === 0), ...root.find('*').toArray()]
    .map(node => labeledValue(normalizeText($(node).text()), label)).filter(Boolean);
}

function labeledValue(value: string, label: RegExp): string { return label.test(value) && value.length < 100 ? value.replace(label, '').replace(/[:\-]/, '').trim() : ''; }
