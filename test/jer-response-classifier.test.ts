import { describe, expect, it } from 'vitest';
import { JerHistoryParser } from '../src/jer/history-parser.js';
import { JerHtmlStructureChangedError } from '../src/jer/domain.js';
import { classifyProviderResponse, classifyHistoricalHtml, isVerificationPage, normalizeVisibleText } from '../src/jer/response-classifier.js';
import { historyWithFifth } from './fixtures.js';

const target = 'https://jer.example/resultados/chontico/';
const game = { code: 'CHONTICO', name: 'Chontico', type: 'CHANCE' as const, detailUrl: target, active: true };
const headers = (values: Record<string, string>) => new Headers(values);

describe('JER response classification', () => {
  it.each([
    ['<main>Espere&nbsp;mientras\nse verifica\t su solicitud</main>', 'espere mientras se verifica su solicitud'],
    ['<p>Verificándo <br> su solicitud</p>', 'verificando su solicitud'],
    ['<span>Verificando</span><span>su solicitud</span>', 'verificando su solicitud'],
  ])('recognizes only normalized user-observed verification text', (html, normalized) => {
    expect(normalizeVisibleText(html)).toBe(normalized);
    expect(isVerificationPage(html)).toBe(true);
  });

  it.each([
    '<main>Espere mientras se verifica su solicitud ahora</main>',
    '<main>No espere mientras se verifica su solicitud</main>',
    '<main>captcha required</main>',
    '<table><tr><td>arbitrary HTML</td></tr></table>',
  ])('does not treat arbitrary or lookalike HTML as a verification page', html => {
    expect(isVerificationPage(html)).toBe(false);
  });

  it.each([
    '<script>Verificando su solicitud</script>',
    '<style>.challenge::after { content: "Verificando su solicitud"; }</style>',
    '<template>Espere mientras se verifica su solicitud</template>',
  ])('ignores verification phrases in non-visible content', html => {
    expect(isVerificationPage(html)).toBe(false);
  });

  it('distinguishes documented target rate limiting from provider outcomes', () => {
    expect(classifyProviderResponse(429, headers({ 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': target }), target)).toBe('rate_limited');
    expect(classifyProviderResponse(429, headers({ 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': 'https://other.example/' }), target)).toBe('provider_error');
    expect(classifyProviderResponse(502, headers({}), target)).toBe('provider_error');
  });

  it('classifies only bounded, recognized historical no-results fixtures as valid_no_results', () => {
    const noResults = '<form><select name="fecha"><option value="2026-07-23">2026-07-23</option></select><div class="resultado-historico">No se encontraron resultados</div></form>';
    const datedNoResults = '<form><select name="fecha"><option value="2026-07-23">2026-07-23</option></select><div class="resultado-historico">No hay resultados para 2026-07-23</div></form>';
    expect(classifyHistoricalHtml(noResults, new JerHistoryParser(), game, '2026-07-23', target)).toEqual({ kind: 'valid_no_results' });
    expect(classifyHistoricalHtml(datedNoResults, new JerHistoryParser(), game, '2026-07-23', target)).toEqual({ kind: 'valid_no_results' });
    expect(() => classifyHistoricalHtml('<main>No se encontraron resultados</main>', new JerHistoryParser(), game, '2026-07-23', target)).toThrow(JerHtmlStructureChangedError);
    expect(classifyHistoricalHtml(historyWithFifth, new JerHistoryParser(), game, '2026-07-23', target).kind).toBe('valid_results');
  });

  it.each([
    '<div class="resultado-historico">No se encontraron resultados</div>',
    '<form><select name="fecha"><option value="2026-07-24">2026-07-24</option></select><div class="resultado-historico">No se encontraron resultados</div></form>',
    '<form><select name="fecha"><option value="2026-07-23">2026-07-23</option></select><div class="resultado-historico">No hay resultados para 2026-07-24</div></form>',
  ])('rejects no-results markup not explicitly tied to the requested date', html => {
    expect(() => classifyHistoricalHtml(html, new JerHistoryParser(), game, '2026-07-23', target)).toThrow(JerHtmlStructureChangedError);
  });

  it.each([
    '<form><input name="fecha" value="2026-07-23"><div class="resultado-historico">No se encontraron resultados</div></form>',
    '<section class="resultado-historico">No hay resultados para 2026-07-23</section>',
  ])('accepts an exact marker only with an explicit requested-date form value or bounded region', html => {
    expect(classifyHistoricalHtml(html, new JerHistoryParser(), game, '2026-07-23', target)).toEqual({ kind: 'valid_no_results' });
  });
});
