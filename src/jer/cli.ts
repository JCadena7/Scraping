import 'dotenv/config';
import { loadConfig } from './config.js';
import { JerHistoryParser } from './history-parser.js';
import { JerHttpClient } from './http-client.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository } from './repository.js';
import { createSupabaseClient } from './supabase.js';
import { BackfillJerResultsUseCase, DiscoverJerGamesUseCase, JerSource, SyncJerLatestResultsUseCase } from './use-cases.js';

export interface CliDependencies { discover: () => Promise<unknown>; latest: () => Promise<{ status: string }>; backfill: (options: { games?: string[]; from?: string; to?: string }) => Promise<{ status: string }>; print: (value: unknown) => void; error: (value: string) => void; }

export function parseArgs(values: string[]): Record<string, string> { return Object.fromEntries(values.filter(value => value.startsWith('--')).map(value => { const [key, ...rest] = value.slice(2).split('='); return [key, rest.join('=')]; })); }
export async function runCli(argv: string[], dependencies: CliDependencies): Promise<number> {
  const [command, ...values] = argv; const args = parseArgs(values); const games = args.games ? args.games.split(',').map(value => value.trim()).filter(Boolean) : args.game ? [args.game] : undefined;
  if (command === 'discover') { dependencies.print(await dependencies.discover()); return 0; }
  if (command === 'latest') return exitCode(await dependencies.latest());
  if (command === 'backfill') return exitCode(await dependencies.backfill({ games, from: args.from, to: args.to }));
  dependencies.error('Usage: pnpm scrape:jer:{discover|latest|backfill} [--game=CODE] [--games=A,B] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]'); return 1;
}
function exitCode(summary: { status: string }): number { return summary.status === 'SUCCESS' ? 0 : summary.status === 'PARTIAL' ? 2 : 1; }

export async function main(): Promise<number> {
  const config = loadConfig();
  if (!config.enabled) { console.error('JER scraper is disabled (JER_SCRAPER_ENABLED=false).'); return 1; }
  const repository = new DrawRepository(createSupabaseClient());
  const client = new JerHttpClient({ timeoutMs: config.timeoutMs, delayMs: config.delayMs, maxRetries: config.maxRetries, userAgent: config.userAgent, logger: event => console.error(JSON.stringify(event)) });
  const source = new JerSource(client, new JerMainPageParser(config.baseUrl), new JerHistoryParser(), config.resultsUrl);
  return runCli(process.argv.slice(2), { discover: async () => { const games = await new DiscoverJerGamesUseCase(source, repository).execute(); games.forEach(game => console.log(`${game.code}\t${game.type}\t${game.name}\t${game.detailUrl}`)); return games; }, latest: async () => { const summary = await new SyncJerLatestResultsUseCase(source, repository).execute(); printSummary(summary); return summary; }, backfill: async options => { const summary = await new BackfillJerResultsUseCase(source, repository).execute(options); printSummary(summary); return summary; }, print: value => console.log(value), error: value => console.error(value) });
}
function printSummary(summary: { id: string; status: string; gamesQueried: number; datesQueried: number; resultsFound: number; resultsInserted: number; resultsUpdated: number; resultsSkipped: number; errors: string[] }) { console.log(JSON.stringify(summary, null, 2)); }

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
