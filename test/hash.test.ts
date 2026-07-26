import { describe, expect, it } from 'vitest';
import { canonicalResultHash } from '../src/jer/hash.js';

const base = {
  gameCode: 'ASTRO_SOL',
  gameType: 'ASTRO',
  drawDate: '2026-07-23',
  drawNumber: null,
  winningNumber: '0017',
  fifthDigit: null,
  series: null,
  zodiacSign: 'PISCIS',
  sourceUrl: null,
};

describe('canonical result hashes', () => {
  it('is stable for equivalent fields regardless of object property order, time, or HTML', () => {
    const reordered = { sourceUrl: null, zodiacSign: 'PISCIS', series: null, fifthDigit: null, winningNumber: '0017', drawNumber: null, drawDate: '2026-07-23', gameType: 'ASTRO', gameCode: 'ASTRO_SOL', fetchedAt: new Date('2030-01-01'), html: '<changed />' };
    expect(canonicalResultHash(base)).toBe(canonicalResultHash(reordered));
  });

  it('prefixes SHA-256 hashes with v2 and changes when a stable field changes', () => {
    const original = canonicalResultHash(base);
    expect(original).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(canonicalResultHash({ ...base, series: 'AB12' })).not.toBe(original);
  });
});
