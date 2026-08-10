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

### Optional Scrape.do backfill provider

**Direct is the default.** Leave `JER_PROVIDER` unset (or set it to `DIRECT`) for the Render discovery/latest/backfill workflow and its existing shared Supabase writes. Scrape.do is available only for `backfill`: an **operational local backfill**; it is not supported for deployed Render discovery or latest collection.

Do not create or commit another environment file. Add these values only to the existing local environment configuration, using a placeholder token in examples:

```env
# Omit JER_PROVIDER, or use DIRECT, for the default transport.
JER_PROVIDER=SCRAPEDO
JER_SCRAPEDO_TOKEN=replace-with-your-scrapedo-token
JER_SCRAPEDO_ENDPOINT=https://api.scrape.do/
JER_SCRAPEDO_SUPER_ENABLED=false
JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS=2
JER_SCRAPEDO_MAX_RETRIES=1
```

```bash
# Scrape.do is allowed only for a deliberately filtered local backfill.
pnpm scrape:jer:backfill --game=CHONTICO_DIA --from=2026-07-01 --to=2026-07-25
```

With `JER_PROVIDER=SCRAPEDO`, `discover` and `latest` fail fast before a Supabase client, repository, lease, runtime, network request, or database access is constructed. There is no direct fallback for an explicit invalid or incomplete Scrape.do configuration. `backfill` keeps the existing shared Supabase result writes and operational controls.

| Variable | Default and validation | Meaning |
|---|---|---|
| `JER_PROVIDER` | `DIRECT`; only `DIRECT` or `SCRAPEDO` | Selects the transport. Unset remains direct. |
| `JER_SCRAPEDO_TOKEN` | Required, non-blank when provider is `SCRAPEDO` | Server-only API token. Invalid explicit Scrape.do configuration fails without falling back to direct. |
| `JER_SCRAPEDO_ENDPOINT` | `https://api.scrape.do/`; must be a URL | API Mode endpoint. |
| `JER_SCRAPEDO_SUPER_ENABLED` | `false`; literal `true` or `false` | Allows Super only after a pending-Super state is persisted; it does not enable Super immediately. Disabled Super at that boundary is terminal. |
| `JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS` | `2`; integer 1–1000 | Consecutive invalidated **Standard sessions** before pending Super, not rotations per request. A valid Standard response resets this count. |
| `JER_SCRAPEDO_MAX_RETRIES` | `1`; literal integer 1 only | The hard maximum: one rotation/retry per logical request, never an unbounded retry setting. |

`JER_SCRAPEDO_MAX_STANDARD_BLOCKED_SESSIONS` is the actual configuration name. It counts confirmed target 403/verification invalidations of Standard sessions; the original request and its one replacement retry can therefore contribute two invalidations. At threshold, the run persists `pendingSuper`; Super starts only on the next operationally permitted request. A Super session is invalidated on a confirmed block but is not rotated by this policy.

### Scrape.do request, session, and failure semantics

The provider uses Scrape.do **API Mode** with `transparentResponse=true`. Target URLs are encoded once by the client, not pre-encoded in configuration. GET and JER POST-form requests retain their method, form body, `Content-Type`, and request headers. The repository has deterministic tests for POST forwarding, but vendor documentation has not been treated as proof that all POST forwarding behavior is supported; that remains an official-documentation evidence gap.

The provider sets no `render`, browser, CAPTCHA, geo, or proxy-mode options. It uses a sticky `sessionId` only. Scrape.do documents `sessionId` as an integer from 0 through 1,000,000 and says an idle sticky assignment is physically closed after approximately five minutes. The persisted ID is logical continuity for this run; it does **not** guarantee the same physical IP indefinitely.

| Observed result | Provider action | Session/source effect |
|---|---|---|
| Trusted target 403 or narrow verification phrase | Blocked | Invalidates Standard; at most one replacement retry. |
| Trusted target 429 (matching target URL and initial-status header) | Rate limited | Existing source cooldown/`RATE_LIMITED` path; no rotation. |
| Provider 429 without trusted target evidence | One same-session, same-tier delayed retry | Then provider failure; no cooldown, rotation, or Super. |
| Provider 401, 400, 502, 510, auth throttling, timeout, or network failure | Provider failure | No rotation, cooldown, or Super. |
| Unknown or structurally invalid HTML | Structure/unknown-HTML failure | No rotation, cooldown, or Super. |

### Cost, database rollout, and safety limits

Scrape.do's published untargeted baseline is 1 credit for Standard and 10 credits for Super. The `Scrape.do-Request-Cost` response header is authoritative because vendor domain profiles can override a baseline. This work did not execute real, billable, or live-provider tests.

The shared production database rollout is additive: `202607270001_scrapedo_jer_provider_state.sql` adds nullable `provider_state` only to `draw_ingestion_runs`. Existing Render/direct rows, legacy RPCs, and direct application behavior remain compatible; the new start/resume and provider-progress RPCs are used only by Scrape.do backfill. **This documentation work has not applied that migration.** Apply prior draw/hardening/operational migrations first, then apply migration 001 before deploying a Scrape.do-backfill caller. If it is already applied, do not edit its history; use a separate transactional migration for later changes. Roll back by disabling the provider and retaining the inert additive schema/RPCs rather than removing shared production state.

Never log, print, commit, or expose the Scrape.do token, provider API URL, sticky session ID, request/form body, Supabase key, or other secrets. The supplied tests are deterministic local checks; they do not prove vendor behavior, account availability, target access, billing, or a production rollout.

Official references: [Scrape.do API Mode and parameters](https://scrape.do/documentation/), [session ID behavior](https://scrape.do/documentation/api-response/session-id/), [transparent response headers](https://scrape.do/documentation/api-response/response-output/#transparent-response), and [request costs](https://scrape.do/documentation/request-costs/).

## CLI behavior

### Portable PostgreSQL backup

The database backup has a separate CLI boundary and does not initialize the scraper, Supabase API client, provider, or JER configuration. It backs up the project-owned `public` schema found in this repository's migrations, including its tables and data, sequences, constraints, indexes, functions, triggers, views, and materialized views. Supabase-managed schemas and cluster roles are not included.

Install PostgreSQL client tools so `pg_dump` and `pg_restore` are on `PATH`, then provide either `DATABASE_URL` or the libpq variables `PGHOST`, `PGDATABASE`, and `PGUSER` (plus `PGPASSWORD` or `.pgpass` when required). Connection values are passed to `pg_dump` through its environment, never command-line arguments.

```bash
# Creates backups/scraper-postgres-YYYYMMDD-HHmmss.dump
pnpm db:backup

# A custom output must retain the .dump extension.
pnpm db:backup --output ./backups/before-import.dump
```

The `.dump` file is a PostgreSQL custom-format archive (`pg_dump -Fc`), not SQL text. The command writes a temporary archive, rejects empty output and existing destinations, then publishes the completed file atomically. Restore into an empty database with a compatible PostgreSQL version:

```bash
PGDATABASE=target_database pg_restore --exit-on-error --no-owner --no-privileges ./backups/before-import.dump
```

Set the remaining target libpq variables (`PGHOST`, `PGPORT`, `PGUSER`, and authentication) as needed. Keep `--no-owner` and `--no-privileges` on restore: PostgreSQL archive restores apply those portability choices at `pg_restore` time. A dump can restore to a newer PostgreSQL major version, but restoring to an older major version is not guaranteed. Extensions or features referenced by application objects must exist on the target server.

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
