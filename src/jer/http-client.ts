import { JerHttpError, JerRateLimitError } from './domain.js';

export interface JerHttpClientOptions { timeoutMs: number; delayMs: number; maxRetries: number; userAgent: string; fetchImpl?: typeof fetch; logger?: (event: Record<string, unknown>) => void; }
type Queue = Promise<void>;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
});

export class JerHttpClient {
  private readonly queues = new Map<string, Queue>();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: JerHttpClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async get(url: string, signal?: AbortSignal): Promise<string> { return this.request(url, { method: 'GET' }, signal); }
  async postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() }, signal);
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
    const domain = new URL(url).hostname;
    const previous = this.queues.get(domain) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(domain, previous.then(() => current));
    await previous;
    try {
      if (this.options.delayMs) await sleep(this.options.delayMs, signal);
      for (let attempt = 1; attempt <= this.options.maxRetries + 1; attempt++) {
        const started = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), this.options.timeoutMs);
        const abort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await this.fetchImpl(url, { ...init, headers: { 'User-Agent': this.options.userAgent, Accept: 'text/html', ...(init.headers ?? {}) }, signal: controller.signal });
          const durationMs = Date.now() - started;
          this.options.logger?.({ status: response.status, url, durationMs, attempt });
          if (response.ok) return await response.text();
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
          if (!retryable || attempt > this.options.maxRetries) {
            if (response.status === 429) throw new JerRateLimitError(`Rate limited by JER: ${url}`, response.status, url, retryAfterMs);
            throw new JerHttpError(`JER returned HTTP ${response.status}: ${url}`, response.status, url);
          }
          await sleep(retryAfterMs ?? backoff(attempt), signal);
        } catch (error) {
          const retryableNetwork = !(error instanceof JerHttpError) && !signal?.aborted;
          if (!retryableNetwork || attempt > this.options.maxRetries) throw error;
          await sleep(backoff(attempt), signal);
        } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
      }
      throw new Error('Unreachable retry state');
    } finally { release(); }
  }
}

function backoff(attempt: number): number { return Math.round(Math.min(30000, 500 * (2 ** (attempt - 1))) * (0.8 + Math.random() * 0.4)); }
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
