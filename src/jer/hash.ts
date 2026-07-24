import { createHash } from 'node:crypto';
export function sourceHash(html: string): string { return createHash('sha256').update(html, 'utf8').digest('hex'); }
