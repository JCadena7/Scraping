import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DiscoveredGame, GameType, JerHtmlStructureChangedError, LatestParse, NormalizedDrawResult, RejectedRow, normalizeSign, normalizeText, validateNormalizedResult } from './domain.js';
import { canonicalResultHash } from './hash.js';

const slugOf = (url: string) => new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
const codeOf = (url: string, name: string) => (slugOf(url) || name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export class JerMainPageParser {
  constructor(private readonly baseUrl: string) {}

  parseGames(html: string): DiscoveredGame[] {
    const $ = cheerio.load(html); const seen = new Set<string>(); const games: DiscoveredGame[] = [];
    $('a.botonres_vmas, a[href*="/resultados/"]').each((_, element) => {
      const href = $(element).attr('href'); if (!href) return;
      let detailUrl: string;
      try { detailUrl = new URL(href, this.baseUrl).toString(); } catch { return; }
      const parsed = new URL(detailUrl); if (parsed.hostname !== new URL(this.baseUrl).hostname || parsed.pathname === '/resultados/' || parsed.pathname.includes('/simuladores/') || !parsed.pathname.startsWith('/resultados/')) return;
      detailUrl = `${parsed.origin}${parsed.pathname}`; const rowName = nameFromRow($, element, detailUrl); const code = codeOf(detailUrl, rowName);
      if (seen.has(detailUrl) || !code) return;
      const name = rowName || code.replace(/_/g, ' ');
      seen.add(detailUrl); games.push({ code, name, type: inferType(code, name), detailUrl, active: true });
    });
    return games;
  }

  parseLatest(html: string, games: DiscoveredGame[], fetchedAt = new Date()): LatestParse {
    const $ = cheerio.load(html); const byUrl = new Map(games.map(game => [game.detailUrl, game])); const results: NormalizedDrawResult[] = []; const rejected: RejectedRow[] = [];
    $('table.tablaresultados').each((tableIndex, table) => {
      const hasThead = $(table).find('thead tr').first().length > 0; const tableRows = hasThead ? $(table).find('tbody tr').toArray() : $(table).find('tr').toArray(); const headerRow = hasThead ? $(table).find('thead tr').first() : $(tableRows.shift() ?? table);
      const headers = headerRow.find('th, td').map((_, cell) => normalizeText($(cell).text()).toLowerCase()).get();
      $(tableRows).each((rowIndex, row) => {
        try {
          const link = $(row).find('a.botonres_vmas, a[href*="/resultados/"]').first(); const href = link.attr('href');
          if (!href) throw new Error('missing historical link');
          const detailUrl = new URL(href, this.baseUrl).toString().replace(/\/$/, '/') ; const game = byUrl.get(detailUrl) ?? games.find(item => new URL(item.detailUrl).pathname === new URL(detailUrl).pathname);
          if (!game) throw new Error(`unknown game for ${detailUrl}`);
          const cells = $(row).find('td').toArray(); const values = cells.map(cell => normalizeText($(cell).text()));
          const winningNumber = extractNumber($, row, cells, headerIndex(headers, 'número', 'numero'));
          if (!/^\d+$/.test(winningNumber)) throw new Error(`invalid winning number: ${winningNumber}`);
          const drawDate = parseDate(findByHeader(headers, values, 'fecha'));
          const fifth = findByHeader(headers, values, 'quinta'); const series = findByHeader(headers, values, 'serie'); const sign = findByHeader(headers, values, 'signo');
           const result = validateNormalizedResult({ gameCode: game.code, gameName: game.name, gameType: game.type, drawDate, winningNumber, fifthDigit: fifth ? fifth.replace(/\D/g, '') || null : null, series: series || null, zodiacSign: sign ? normalizeSign(sign) : null, sourceUrl: detailUrl, fetchedAt, sourceHash: '', verified: true });
           results.push({ ...result, sourceHash: canonicalResultHash(result) });
        } catch (error) { rejected.push({ row: tableIndex * 10000 + rowIndex + 1, reason: error instanceof Error ? error.message : String(error) }); }
      });
    });
    return { results, rejected };
  }
}

function extractNumber($: cheerio.CheerioAPI, row: AnyNode, cells: AnyNode[], index: number): string {
  const digitNodes = $(row).find('.cajon-baloteras .balotera-home, .balotera-home').toArray();
  if (digitNodes.length) return digitNodes.map(node => normalizeText($(node).text())).join('');
  return normalizeText($(cells[index >= 0 ? index : 0]).text()).replace(/\s+/g, '');
}
function headerIndex(headers: string[], ...names: string[]) { return headers.findIndex(header => names.some(name => header.includes(name))); }
function findByHeader(headers: string[], values: string[], name: string): string { const index = headers.findIndex(header => header.includes(name)); return index >= 0 ? values[index] ?? '' : ''; }
function parseDate(value: string): string { const iso = value.match(/\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`; const local = value.match(/\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/); if (local) return `${local[3]}-${local[2]}-${local[1]}`; throw new JerHtmlStructureChangedError(`missing or invalid date: ${value}`); }
function inferType(code: string, name: string): GameType { const value = `${code} ${name}`.toUpperCase(); if (value.includes('ASTRO')) return 'ASTRO'; if (value.includes('DUPLA')) return 'DUPLA'; if (value.includes('LOTERIA')) return 'LOTTERY'; if (value.includes('CHANCE') || value.includes('SORTEO') || /DIA|TARDE|NOCHE|MANANA|MAÑANA/.test(value)) return 'CHANCE'; return 'OTHER'; }
function nameFromRow($: cheerio.CheerioAPI, element: AnyNode, detailUrl: string): string {
  const candidate = $(element).closest('tr').find('td, th').toArray().map(cell => normalizeText($(cell).clone().find('a').remove().end().text())).find(value => value && value !== '+' && !/^ver\s*m[aá]s$/i.test(value) && !/^\d+[\d\s-]*$/.test(value) && !/^\d{2,4}[-/.]\d{2}[-/.]\d{2,4}$/.test(value));
  if (candidate) return candidate;
  return slugOf(detailUrl).replace(/^resultados-(sorteo-|loteria-)?/, '').replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
