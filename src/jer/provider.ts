import type { JerTransport } from './http-client.js';
import { JerBlockedError, JerRateLimitError } from './domain.js';
import { classifyProviderResponse } from './response-classifier.js';
import { ScrapedoProviderError, type ScrapedoRawResponse } from './scrapedo-runtime.js';

export interface ScrapedoHttpClientOptions {
  endpoint: string;
  token: string;
  timeoutMs: number;
  userAgent: string;
  sessionId?: number;
  super?: boolean;
  fetchImpl?: typeof fetch;
  logger?: (event: Record<string, unknown>) => void;
}

export class ScrapedoHttpClient implements JerTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ScrapedoHttpClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  get(url: string, signal?: AbortSignal): Promise<string> { return this.requestLegacy(url, { method: 'GET' }, signal); }

  postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return this.requestLegacy(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() }, signal);
  }

  async requestRaw(targetUrl: string, init: RequestInit, signal?: AbortSignal): Promise<ScrapedoRawResponse> {
    throwIfAborted(signal);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), this.options.timeoutMs);
    const abort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(this.apiUrl(targetUrl), { ...init, headers: { Accept: 'text/html', 'User-Agent': this.options.userAgent, ...(init.headers ?? {}) }, signal: controller.signal });
      this.options.logger?.({ provider: 'SCRAPEDO', tier: this.options.super ? 'SUPER' : 'STANDARD', attempt: 1, classification: response.status >= 200 && response.status < 300 ? 'response' : 'provider_error', status: response.status, durationMs: Date.now() - startedAt, super: this.options.super === true });
      return { status: response.status, headers: response.headers, body: await response.text() };
    } catch {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      if (controller.signal.aborted) throw new ScrapedoProviderError('timeout');
      throw new ScrapedoProviderError('network');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async requestLegacy(targetUrl: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
    const response = await this.requestRaw(targetUrl, init, signal);
    const classification = classifyProviderResponse(response.status, response.headers, targetUrl);
      if (classification === 'blocked') throw new JerBlockedError('JER target returned HTTP 403', 403, targetUrl);
      if (classification === 'rate_limited') throw new JerRateLimitError('JER target returned HTTP 429', 429, targetUrl);
    if (response.status < 200 || response.status >= 300) throw new Error(`Scrape.do request failed with HTTP ${response.status}`);
    return response.body;
  }

  private apiUrl(targetUrl: string): string {
    const url = new URL(this.options.endpoint);
    url.searchParams.set('token', this.options.token);
    url.searchParams.set('url', targetUrl);
    url.searchParams.set('transparentResponse', 'true');
    if (this.options.sessionId !== undefined) url.searchParams.set('sessionId', String(this.options.sessionId));
    if (this.options.super) url.searchParams.set('super', 'true');
    return url.toString();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}
