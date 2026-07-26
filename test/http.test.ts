import { describe, expect, it, vi } from 'vitest';
import { JerBlockedError } from '../src/jer/domain.js';
import { JerHttpClient } from '../src/jer/http-client.js';

describe('JerHttpClient', () => {
  it('retries 500 and succeeds, and sends form data', async () => { let calls = 0; const fetchImpl: typeof fetch = vi.fn(async (_url, init?: RequestInit) => { calls++; if (calls === 1) return new Response('error', { status: 500 }); return new Response(`ok:${init?.body ?? ''}`, { status: 200 }); }); const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 1, userAgent: 'test', fetchImpl }); await expect(client.postForm('https://jer.com.co/x', { fecha: '2026-07-23' })).resolves.toContain('fecha=2026-07-23'); expect(calls).toBe(2); });
  it('honors 429 as a rate-limit error after retry budget', async () => { const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '0' } })); const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 0, userAgent: 'test', fetchImpl }); await expect(client.get('https://jer.com.co/x')).rejects.toMatchObject({ name: 'JerRateLimitError', status: 429 }); });
  it('throws a typed blocked error for 403 without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 5, userAgent: 'test', fetchImpl });

    await expect(client.get('https://jer.com.co/blocked')).rejects.toBeInstanceOf(JerBlockedError);
    await expect(client.get('https://jer.com.co/blocked')).rejects.toMatchObject({ status: 403, url: 'https://jer.com.co/blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('retains valid Retry-After metadata after exhausting retries for the same request only', async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } }));
    const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 1, userAgent: 'test', fetchImpl, sleepImpl, random: () => 0.5 });

    await expect(client.get('https://jer.com.co/rate-limited')).rejects.toMatchObject({ status: 429, url: 'https://jer.com.co/rate-limited', retryAfterMs: 7000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(7000, undefined);
  });
  it('uses deterministic backoff for malformed Retry-After while preserving 5xx and network retries', async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const malformedFetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': 'not-a-date' } }));
    const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 1, userAgent: 'test', fetchImpl: malformedFetch, sleepImpl, random: () => 0.5 });

    await expect(client.get('https://jer.com.co/malformed')).rejects.toMatchObject({ retryAfterMs: undefined });
    expect(sleepImpl).toHaveBeenCalledWith(500, undefined);

    const recoverableFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const retryingClient = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 2, userAgent: 'test', fetchImpl: recoverableFetch, sleepImpl, random: () => 0.5 });
    await expect(retryingClient.get('https://jer.com.co/retry')).resolves.toBe('ok');
    expect(recoverableFetch).toHaveBeenCalledTimes(3);
  });
});
