import { JerBlockedError, JerHttpError, JerRateLimitError } from './domain.js';

export interface JerHttpClientOptions { timeoutMs: number; delayMs: number; maxRetries: number; userAgent: string; fetchImpl?: typeof fetch; sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; random?: () => number; backoffImpl?: (attempt: number) => number; logger?: (event: Record<string, unknown>) => void; }
export interface JerTransport { get(url: string, signal?: AbortSignal): Promise<string>; postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<string>; }
type Queue = Promise<void>;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
});

export class JerHttpClient {
  private readonly queues = new Map<string, Queue>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly backoff: (attempt: number) => number;
  constructor(private readonly options: JerHttpClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; this.sleepImpl = options.sleepImpl ?? sleep; this.now = options.now ?? Date.now; this.backoff = options.backoffImpl ?? (attempt => backoff(attempt, options.random ?? Math.random)); }

  async get(url: string, signal?: AbortSignal): Promise<string> { return this.request(url, { method: 'GET' }, signal); }
  async postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() }, signal);
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const domain = new URL(url).hostname;
    const previous = this.queues.get(domain) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(domain, previous.then(() => current));
    try {
      await waitFor(previous, signal);
      throwIfAborted(signal);
      if (this.options.delayMs) { await this.sleepImpl(this.options.delayMs, signal); throwIfAborted(signal); }
      for (let attempt = 1; attempt <= this.options.maxRetries + 1; attempt++) {
        throwIfAborted(signal);
        const started = this.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), this.options.timeoutMs);
        const abort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        try {
          throwIfAborted(signal);
          const response = await this.fetchImpl(url, { ...init, headers: { 'User-Agent': this.options.userAgent, Accept: 'text/html', ...(init.headers ?? {}) }, signal: controller.signal });
          const durationMs = this.now() - started;
          this.options.logger?.({ status: response.status, url, durationMs, attempt });
          if (response.ok) return await response.text();
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now);
          const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
          if (!retryable || attempt > this.options.maxRetries) {
            if (response.status === 403) throw new JerBlockedError(`Blocked by JER: ${url}`, response.status, url);
            if (response.status === 429) throw new JerRateLimitError(`Rate limited by JER: ${url}`, response.status, url, retryAfterMs);
            throw new JerHttpError(`JER returned HTTP ${response.status}: ${url}`, response.status, url);
          }
          await this.sleepImpl(retryAfterMs ?? this.backoff(attempt), signal); throwIfAborted(signal);
        } catch (error) {
          const retryableNetwork = !(error instanceof JerHttpError) && !signal?.aborted;
          if (!retryableNetwork || attempt > this.options.maxRetries) throw error;
          await this.sleepImpl(this.backoff(attempt), signal); throwIfAborted(signal);
        } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
      }
      throw new Error('Unreachable retry state');
    } finally { release(); }
  }
}

function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error('Aborted'); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortReason(signal); }
function waitFor(waiting: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return waiting;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    waiting.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function backoff(attempt: number, random: () => number): number { return Math.round(Math.min(30000, 500 * (2 ** (attempt - 1))) * (0.8 + random() * 0.4)); }
export function parseRetryAfter(value: string | null, now: () => number = Date.now): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}
