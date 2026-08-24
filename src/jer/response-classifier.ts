import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { JerHtmlStructureChangedError, type DiscoveredGame, type NormalizedDrawResult } from './domain.js';
import { JerHistoryParser } from './history-parser.js';

export type ProviderResponseClassification = 'blocked' | 'rate_limited' | 'provider_error';
export type HistoricalHtmlClassification = { kind: 'verification_page' } | { kind: 'valid_no_results' } | { kind: 'valid_results'; result: NormalizedDrawResult };

const verificationMessages = new Set([
  'espere mientras se verifica su solicitud',
  'verificando su solicitud',
]);
const verificationTitles = new Set([
  'one moment, please...',
]);

export function normalizeVisibleText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, template, noscript, head, [hidden], [aria-hidden="true"]').remove();
  const separatedHtml = ($.root().html() ?? '').replace(/<[^>]*>/g, ' ');
  return cheerio.load(separatedHtml).text().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isVerificationPage(html: string): boolean {
  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
  return verificationMessages.has(normalizeVisibleText(html)) || verificationTitles.has(title);
}

export function classifyProviderResponse(status: number, headers: Headers, targetUrl: string): ProviderResponseClassification {
  if (status === 403 && isDocumentedTargetStatus(status, headers, targetUrl)) return 'blocked';
  if (status === 429 && isDocumentedTargetStatus(status, headers, targetUrl)) return 'rate_limited';
  return 'provider_error';
}

export function classifyHistoricalHtml(html: string, parser: JerHistoryParser, game: DiscoveredGame, requestedDate: string, sourceUrl: string): HistoricalHtmlClassification {
  if (isVerificationPage(html)) return { kind: 'verification_page' };
  if (hasBoundedNoResultsMarker(html, requestedDate)) return { kind: 'valid_no_results' };
  try {
    return { kind: 'valid_results', result: parser.parse(html, game, requestedDate, sourceUrl) };
  } catch (error) {
    if (error instanceof JerHtmlStructureChangedError) throw error;
    throw error;
  }
}

function isDocumentedTargetStatus(status: number, headers: Headers, targetUrl: string): boolean {
  if (headers.get('Scrape.do-Initial-Status-Code') !== String(status)) return false;
  const documentedTarget = headers.get('Scrape.do-Target-Url');
  if (!documentedTarget) return false;
  try { return new URL(documentedTarget).href === new URL(targetUrl).href; }
  catch { return false; }
}

function hasBoundedNoResultsMarker(html: string, requestedDate: string): boolean {
  const $ = cheerio.load(html);
  const expected = new Set(['no se encontraron resultados', `no hay resultados para ${requestedDate}`]);
  return $('.resultado-historico, .resultado-sorteo').toArray().some(root => {
    if (!expected.has(normalizeVisibleText($.html(root)))) return false;
    return hasRequestedDateControl($, $(root).closest('form').first(), requestedDate)
      || normalizeVisibleText($.html(root)).includes(requestedDate);
  });
}

function hasRequestedDateControl($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>, requestedDate: string): boolean {
  return form.find('select[name="fecha"] option, input[name="fecha"], button[name="fecha"]').toArray()
    .some(control => $(control).attr('value') === requestedDate);
}
