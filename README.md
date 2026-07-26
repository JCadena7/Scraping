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
| `1` | `FAILED` | Invalid command, configuration, filter, disabled source, foreign live lease, or ordinary failure. |
| `2` | `PARTIAL` | At least one requested operation failed while another completed. |
| `3` | `BLOCKED` | JER returned 403 or the persistent source cooldown is blocked. |
| `4` | `PAUSED` / `RATE_LIMITED` | JER exhausted 429 retries and the persistent source is rate-limited. |
| `130` | `CANCELLED` | SIGINT or SIGTERM stopped the active command cleanly. |

Operational limits (`max-results` or `max-batches`) return `PAUSED` with exit `0`: this is a planned, resumable boundary, not source rate limiting. Exit `4` is reserved for persistent JER `RATE_LIMITED` telemetry.

For `backfill`, `--game=CODE` and `--games=A,B` are validated against the persisted JER catalog before any JER request. Unknown codes fail with exit `1`; a filtered run also fails clearly when the persisted catalog is empty, so it cannot silently succeed with zero games. Run `discover` first to create or refresh that catalog.

Backfill reads a game's available dates, skips dates already persisted, and saves each result immediately. Re-run the same command after interruption to resume; existing dates remain skipped.

## Operational guards

Every JER command acquires the singleton `JER/jer.com.co` source gate and owner-token lease before its first network request. A live foreign lease or `DISABLED` source exits `1` without running; `BLOCKED` exits `3`; `RATE_LIMITED` exits `4`. The owner renews its lease independently while work or a batch pause is in progress and releases it once in finalization.

Set these optional environment variables (default, inclusive bounds): `JER_BATCH_SIZE=5` (1–50), `JER_MAX_BATCHES_PER_RUN=5` (1–100), `JER_MAX_RESULTS_PER_RUN=25` (1–1000), `JER_REQUEST_DELAY_MS=10000` (5000–60000), `JER_BATCH_PAUSE_MS=180000` (30000–3600000), `JER_CONCURRENCY=1` (literal only), `JER_MAX_RETRIES=5` (0–10), `JER_BLOCK_COOLDOWN_MS=21600000` (3600000–86400000), `JER_RATE_LIMIT_COOLDOWN_MS=3600000` (60000–21600000), `JER_LEASE_DURATION_MS=60000` (30000–900000), and `JER_LEASE_RENEW_INTERVAL_MS=20000` (5000–300000 and less than the lease duration). Unknown or malformed `JER_*` values and operational CLI overrides fail before a lease or network request.

```bash
# Use a code printed by discover; examples are not a fixed catalog.
pnpm scrape:jer:backfill --game=CHONTICO_DIA --batch-size=5 --max-batches=2 --max-results=10
pnpm scrape:jer:backfill --games=CHONTICO_DIA,ASTRO_SOL --from=2026-07-01 --to=2026-07-25 --batch-size=3
```

The long aliases `--max-batches-per-run` and `--max-results-per-run` remain supported. Additional validated overrides are `--request-delay-ms`, `--batch-pause-ms`, `--concurrency`, `--max-retries`, `--block-cooldown-ms`, `--rate-limit-cooldown-ms`, `--lease-duration-ms`, and `--lease-renew-interval-ms`.

Backfill is sequential: `attempted results = min(authoritative missing dates, max results)` across all selected games. A batch has at most `batch-size` attempts; another starts only while both limits remain. The batch pause occurs only between eligible batches. Existing stored dates are authoritative on resume; `nextPendingDate` is telemetry only.

403 stores a six-hour default blocked cooldown; exhausted 429 stores `max(valid Retry-After, configured rate-limit cooldown)`. Both stop later requests. No proxy, CAPTCHA solver, stealth behavior, fingerprint manipulation, or parallelization is used. SIGINT/SIGTERM abort fetches, sleeps, and heartbeats through one controller; backfill records `CANCELLED`, preserves earlier immediate saves, releases its owner lease once, and exits 130.

Apply `202607240003_jer_operational_guards.sql` after the prior draw and hardening migrations, before deploying this CLI. It adds persistent source state, leases, progress, and service-role-only RPCs. Rollback is operational: stop commands and deploy the previous application; retain the additive migration and its audit state rather than deleting production history.

## Networking and cancellation

Requests are serialized per domain, use a conservative configured delay, retry transient failures, and honor `Retry-After`. An `AbortSignal` is checked before queue admission, while waiting, after delay/backoff, and before fetch. A cancelled request does not fetch and releases its queue gate so later same-domain work continues. Cancellation is a `CANCELLED` CLI outcome with exit `130`, never a failed or silent-success outcome.

## Parsing and hashes

The parser uses bounded, game-specific historical result containers. It accepts LOTTERY, CHANCE, ASTRO, and DUPLA results only when the winning number has exactly four digits; unknown layouts/types fail closed and are not persisted. To support another JER layout, add a bounded parser strategy, frozen fixtures, and red-green-refactor tests before enabling it.

Each normalized result has a deterministic `v2:` SHA-256 hash built from stable normalized fields and source URL fragments. It intentionally excludes mutable whole-page HTML and timestamps. Legacy hashes can be re-baselined once by the RPC; later v2 changes are retained in the audit trail.
