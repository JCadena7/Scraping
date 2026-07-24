# JER Results Scraper

This Node.js scraper discovers, normalizes, and stores JER SuRed draw results in Supabase/PostgreSQL. It fetches server-rendered HTML with `fetch` and Cheerio; it does not use SQLite, browser automation, Playwright, Puppeteer, or Selenium.

## Quick path

1. Apply the draw-results migration, then `supabase/migrations/202607240001_harden_jer_persistence.sql`.
2. Configure a server-only Supabase service-role key.
3. Discover the catalog before running a filtered backfill.

```bash
pnpm install
pnpm scrape:jer:discover
pnpm scrape:jer:latest
pnpm scrape:jer:backfill --game=CHONTICO_DIA
pnpm scrape:jer:backfill --games=CHONTICO_DIA,RESULTADOS_SORTEO_ANTIOQUENITA_DIA
pnpm scrape:jer:backfill --game=CHONTICO_DIA --from=2024-01-01 --to=2026-07-23
```

Game codes are generated from JER result-page URL slugs, not maintained as a fixed list. The fixture catalog demonstrates `CHONTICO_DIA`, `RESULTADOS_SORTEO_ANTIOQUENITA_DIA`, `ASTRO_SOL`, and `DUPLA`; use `pnpm scrape:jer:discover` to print the current production codes before filtering.

## Configuration and security

```env
JER_RESULTS_BASE_URL=https://jer.com.co
JER_RESULTS_PATH=/resultados/
JER_REQUEST_TIMEOUT_MS=30000
JER_REQUEST_DELAY_MS=5000
JER_MAX_RETRIES=5
JER_USER_AGENT=ResultadosColombia/1.0 contacto@example.com
JER_SCRAPER_ENABLED=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
```

`SUPABASE_SERVICE_ROLE_KEY` is required and must never be exposed to browsers or committed. The hardening migration enables RLS on the scraper tables, denies anonymous and authenticated access, and grants the `upsert_draw_result` RPC only to `service_role`. The repository persists results through that RPC; direct public-client writes are not supported.

Apply migrations in order: first `202607230001_draw_results.sql`, then `202607240001_harden_jer_persistence.sql`. Deploy application code that requires the service-role key only after the security migration is live.

## CLI behavior

| Exit code | Status | Meaning |
|---|---|---|
| `0` | `SUCCESS` | All requested work completed. |
| `1` | `FAILED` | Invalid command, configuration, filter, cancellation, or complete failure. |
| `2` | `PARTIAL` | At least one requested operation failed while another completed. |

For `backfill`, `--game=CODE` and `--games=A,B` are validated against the persisted JER catalog before any JER request. Unknown codes fail with exit `1`; a filtered run also fails clearly when the persisted catalog is empty, so it cannot silently succeed with zero games. Run `discover` first to create or refresh that catalog.

Backfill reads a game's available dates, skips dates already persisted, and saves each result immediately. Re-run the same command after interruption to resume; existing dates remain skipped.

## Networking and cancellation

Requests are serialized per domain, use a conservative configured delay, retry transient failures, and honor `Retry-After`. An `AbortSignal` is checked before queue admission, while waiting, after delay/backoff, and before fetch. A cancelled request does not fetch and releases its queue gate so later same-domain work continues. Cancellation is a failed CLI outcome, never a silent success.

## Parsing and hashes

The parser uses bounded, game-specific historical result containers. It accepts LOTTERY, CHANCE, ASTRO, and DUPLA results only when the winning number has exactly four digits; unknown layouts/types fail closed and are not persisted. To support another JER layout, add a bounded parser strategy, frozen fixtures, and red-green-refactor tests before enabling it.

Each normalized result has a deterministic `v2:` SHA-256 hash built from stable normalized fields and source URL fragments. It intentionally excludes mutable whole-page HTML and timestamps. Legacy hashes can be re-baselined once by the RPC; later v2 changes are retained in the audit trail.
