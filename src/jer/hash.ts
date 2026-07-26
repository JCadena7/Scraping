import { createHash } from 'node:crypto';

export interface CanonicalResultFields {
  gameCode: string;
  gameType: string;
  drawDate: string;
  drawNumber?: string | null;
  winningNumber: string;
  fifthDigit?: string | null;
  series?: string | null;
  zodiacSign?: string | null;
  sourceUrl?: string | null;
}

export function canonicalResultHash(result: CanonicalResultFields): string {
  const fields = [
    result.gameCode,
    result.gameType,
    result.drawDate,
    result.drawNumber,
    result.winningNumber,
    result.fifthDigit,
    result.series,
    result.zodiacSign,
    result.sourceUrl,
  ].map(value => value == null ? '' : String(value).trim());
  return `v2:${createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')}`;
}

export function sourceHash(html: string): string { return createHash('sha256').update(html, 'utf8').digest('hex'); }
