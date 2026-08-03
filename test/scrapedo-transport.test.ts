import { describe, expect, it, vi } from 'vitest';
import { JerBlockedError, JerRateLimitError } from '../src/jer/domain.js';
import { ScrapedoHttpClient } from '../src/jer/provider.js';
import { ScrapedoProviderError } from '../src/jer/scrapedo-runtime.js';

const token = 'api+token/with?reserved&characters=';
const target = 'https://jer.example/resultados/?game=chontico&source=history';

function requestUrl(fetchImpl: ReturnType<typeof vi.fn>): URL {
  return new URL(fetchImpl.mock.calls[0][0] as string);
}

describe('Scrape.do API Mode transport', () => {
  it.each([
    [403, JerBlockedError],
    [429, JerRateLimitError],
  ])('classifies documented matching target HTTP %i as a JER response', async (status, ErrorType) => {
    const headers = { 'Scrape.do-Initial-Status-Code': String(status), 'Scrape.do-Target-Url': target };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers }));
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 1_000, userAgent: 'test-agent', fetchImpl });
    const error = await client.get(target).catch(value => value);
    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toMatchObject({ status, url: target });
    expect(String(error)).not.toContain(token);
  });

  it.each([
    [403, {}],
    [429, { 'Scrape.do-Initial-Status-Code': '429', 'Scrape.do-Target-Url': 'https://other.example/' }],
  ])('keeps untrusted provider HTTP %i outside JER transitions', async (status, headers) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers }));
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 1_000, userAgent: 'test-agent', fetchImpl });
    const error = await client.get(target).catch(value => value);
    expect(error.constructor).toBe(Error);
    expect(String(error)).toBe(`Error: Scrape.do request failed with HTTP ${status}`);
  });

  it('keeps direct behavior available through the existing client and builds a once-encoded GET API Mode request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 1_000, userAgent: 'test-agent', fetchImpl });

    await expect(client.get(target)).resolves.toBe('<html>ok</html>');
    const url = requestUrl(fetchImpl);
    expect(url.origin + url.pathname).toBe('https://api.scrape.do/');
    expect(url.searchParams.get('token') === token).toBe(true);
    expect(url.search.includes(encodeURIComponent(encodeURIComponent(token)))).toBe(false);
    expect(url.searchParams.get('url')).toBe(target);
    expect(url.search).not.toContain(encodeURIComponent(encodeURIComponent(target)));
    expect(url.searchParams.get('transparentResponse')).toBe('true');
    expect(url.searchParams.has('sessionId')).toBe(false);
    expect(url.searchParams.has('super')).toBe(false);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Accept: 'text/html', 'User-Agent': 'test-agent' } });
  });

  it('preserves POST form method, body, content type, safe headers, and requested session/tier without forwarding API parameters to JER', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 1_000, userAgent: 'test-agent', sessionId: 0, super: true, fetchImpl });

    await expect(client.postForm(target, { fecha: '2026-07-23', category: 'día' })).resolves.toBe('ok');
    const url = requestUrl(fetchImpl);
    expect(url.searchParams.get('sessionId')).toBe('0');
    expect(url.searchParams.get('super')).toBe('true');
    expect(url.searchParams.get('url')).toBe(target);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('fecha=2026-07-23&category=d%C3%ADa');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', 'User-Agent': 'test-agent' });
    expect(String(init.body)).not.toContain('token=');
    expect(String(init.body)).not.toContain('transparentResponse');
  });

  it('transports a supplied integer session ID without defining session policy', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 1_000, userAgent: 'test-agent', sessionId: 734, fetchImpl });
    await client.get(target);
    expect(requestUrl(fetchImpl).searchParams.get('sessionId')).toBe('734');
  });

  it('propagates caller cancellation and timeout without logging or exposing credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })));
    const logger = vi.fn();
    const client = new ScrapedoHttpClient({ endpoint: 'https://api.scrape.do/', token, timeoutMs: 5, userAgent: 'test-agent', fetchImpl, logger });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(client.get(target, controller.signal)).rejects.toThrow('caller cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.get(target)).rejects.toThrow('Request timeout');
    expect(String(logger.mock.calls)).not.toContain(token);
  });

  it('redacts token, API URL, and target URL on the actual network-error transport path', async () => {
    const endpoint = 'https://api.scrape.do/private?account=sensitive-account';
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`fetch failed for ${token} via ${endpoint} at ${target}`));
    const client = new ScrapedoHttpClient({ endpoint, token, timeoutMs: 1_000, userAgent: 'test-agent', fetchImpl });

    const error = await client.get(target).catch(value => value);
    expect(error).toBeInstanceOf(ScrapedoProviderError);
    expect(error).toMatchObject({ kind: 'network', code: 'SCRAPEDO_PROVIDER_ERROR' });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(endpoint);
    expect(String(error)).not.toContain(target);
    expect(error).not.toHaveProperty('url');
    expect(error).not.toHaveProperty('token');
  });

  it('emits a redacted structured provider event on the actual request path', async () => {
    const endpoint = 'https://api.scrape.do/private?account=sensitive-account';
    const supabaseSecret = 'sb_secret_supabase_credential';
    const logger = vi.fn();
    const client = new ScrapedoHttpClient({ endpoint, token, timeoutMs: 1_000, userAgent: 'test-agent', sessionId: 734, super: true, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 502 })), logger });

    await client.requestRaw(target, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Supabase-Key': supabaseSecret }, body: `fecha=2026-07-01&supabase=${supabaseSecret}` });

    const serialized = JSON.stringify(logger.mock.calls);
    expect(logger).toHaveBeenCalledOnce();
    const [event] = logger.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(event).sort()).toEqual(['attempt', 'classification', 'durationMs', 'provider', 'status', 'super', 'tier']);
    expect(event).toMatchObject({ provider: 'SCRAPEDO', tier: 'SUPER', attempt: 1, classification: 'provider_error', status: 502, super: true });
    expect(typeof event.provider).toBe('string');
    expect(typeof event.tier).toBe('string');
    expect(typeof event.attempt).toBe('number');
    expect(typeof event.classification).toBe('string');
    expect(typeof event.status).toBe('number');
    expect(typeof event.durationMs).toBe('number');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof event.super).toBe('boolean');
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain(target);
    expect(serialized).not.toContain('734');
    expect(serialized).not.toContain('fecha=');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain(supabaseSecret);
  });
});
