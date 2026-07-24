import 'dotenv/config';
import { loadConfig } from './config.js';
import { JerHistoryParser } from './history-parser.js';
import { JerHttpClient } from './http-client.js';
import { JerMainPageParser } from './main-page-parser.js';
import { DrawRepository } from './repository.js';
import { createSupabaseClient } from './supabase.js';
import { BackfillJerResultsUseCase, DiscoverJerGamesUseCase, JerSource, SyncJerLatestResultsUseCase } from './use-cases.js';

const config = loadConfig();
if (!config.enabled) { console.error('JER scraper is disabled (JER_SCRAPER_ENABLED=false).'); process.exitCode = 2; } else {
  const repository = new DrawRepository(createSupabaseClient());
  const client = new JerHttpClient({ timeoutMs: config.timeoutMs, delayMs: config.delayMs, maxRetries: config.maxRetries, userAgent: config.userAgent, logger: event => console.error(JSON.stringify(event)) });
  const source = new JerSource(client, new JerMainPageParser(config.baseUrl), new JerHistoryParser(), config.resultsUrl);
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const run = async () => {
    if (command === 'discover') { const games = await new DiscoverJerGamesUseCase(source, repository).execute(); games.forEach(game => console.log(`${game.code}\t${game.type}\t${game.name}\t${game.detailUrl}`)); return 0; }
    if (command === 'latest') { printSummary(await new SyncJerLatestResultsUseCase(source, repository).execute()); return 0; }
    if (command === 'backfill') { const games = args.games ? args.games.split(',').map(value => value.trim()).filter(Boolean) : args.game ? [args.game] : undefined; const summary = await new BackfillJerResultsUseCase(source, repository).execute({ games, from: args.from, to: args.to }); printSummary(summary); return summary.status === 'FAILED' ? 1 : 0; }
    console.error('Usage: pnpm scrape:jer:{discover|latest|backfill} [--game=CODE] [--games=A,B] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]'); return 2;
  };
  run().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

function parseArgs(values: string[]): Record<string, string> { return Object.fromEntries(values.filter(value => value.startsWith('--')).map(value => { const [key, ...rest] = value.slice(2).split('='); return [key, rest.join('=')]; })); }
function printSummary(summary: { id: string; status: string; gamesQueried: number; datesQueried: number; resultsFound: number; resultsInserted: number; resultsUpdated: number; resultsSkipped: number; errors: string[] }) { console.log(JSON.stringify(summary, null, 2)); }
