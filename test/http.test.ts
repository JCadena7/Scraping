import { describe, expect, it, vi } from 'vitest';
import { JerHttpClient } from '../src/jer/http-client.js';

describe('JerHttpClient', () => {
  it('retries 500 and succeeds, and sends form data', async () => { let calls = 0; const fetchImpl: typeof fetch = vi.fn(async (_url, init?: RequestInit) => { calls++; if (calls === 1) return new Response('error', { status: 500 }); return new Response(`ok:${init?.body ?? ''}`, { status: 200 }); }); const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 1, userAgent: 'test', fetchImpl }); await expect(client.postForm('https://jer.com.co/x', { fecha: '2026-07-23' })).resolves.toContain('fecha=2026-07-23'); expect(calls).toBe(2); });
  it('honors 429 as a rate-limit error after retry budget', async () => { const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '0' } })); const client = new JerHttpClient({ timeoutMs: 1000, delayMs: 0, maxRetries: 0, userAgent: 'test', fetchImpl }); await expect(client.get('https://jer.com.co/x')).rejects.toMatchObject({ name: 'JerRateLimitError', status: 429 }); });
});
