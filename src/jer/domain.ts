export type GameType = 'LOTTERY' | 'CHANCE' | 'ASTRO' | 'DUPLA' | 'OTHER';
export type IngestionStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';

export interface DiscoveredGame {
  code: string;
  name: string;
  type: GameType;
  detailUrl: string;
  active: boolean;
}

export interface NormalizedDrawResult {
  gameCode: string;
  gameName: string;
  gameType: GameType;
  drawDate: string;
  drawNumber?: string | null;
  winningNumber: string;
  fifthDigit?: string | null;
  series?: string | null;
  zodiacSign?: string | null;
  sourceUrl: string;
  fetchedAt: Date;
  sourceHash: string;
  verified: boolean;
}

export interface RejectedRow { row: number; reason: string; }
export interface LatestParse { results: NormalizedDrawResult[]; rejected: RejectedRow[]; }

export class JerError extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = 'JerError'; } }
export class JerHttpError extends JerError { constructor(message: string, public readonly status: number, public readonly url: string) { super(message, 'JER_HTTP_ERROR'); this.name = 'JerHttpError'; } }
export class JerRateLimitError extends JerHttpError { constructor(message: string, status: number, url: string, public readonly retryAfterMs?: number) { super(message, status, url); this.name = 'JerRateLimitError'; } }
export class JerHtmlStructureChangedError extends JerError { constructor(message: string) { super(message, 'JER_HTML_STRUCTURE_CHANGED'); this.name = 'JerHtmlStructureChangedError'; } }
export class JerResultNotFoundError extends JerError { constructor(message: string) { super(message, 'JER_RESULT_NOT_FOUND'); this.name = 'JerResultNotFoundError'; } }
export class JerDateMismatchError extends JerError { constructor(expected: string, actual: string) { super(`Requested date ${expected}, response date ${actual}`, 'JER_DATE_MISMATCH'); this.name = 'JerDateMismatchError'; } }
export class JerInvalidResultError extends JerError { constructor(message: string) { super(message, 'JER_INVALID_RESULT'); this.name = 'JerInvalidResultError'; } }

export function assertDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new JerInvalidResultError(`Invalid date: ${value}`);
  const date = new Date(`${value}T12:00:00-05:00`);
  if (Number.isNaN(date.getTime()) || date.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }) !== value) throw new JerInvalidResultError(`Invalid date: ${value}`);
  return value;
}

export function normalizeText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
export function normalizeSign(value: string): string { return normalizeText(value).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
