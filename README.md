# JER Results Scraper

Módulo Node.js para descubrir, normalizar y almacenar resultados publicados por JER SuRed. El sitio entrega HTML renderizado en servidor, por lo que el scraper usa `fetch` y `cheerio`; no necesita Playwright, Puppeteer ni Selenium.

## Arquitectura

`src/jer/http-client.ts` aplica timeout, `AbortSignal`, User-Agent, una cola por dominio, intervalo entre solicitudes, reintentos de errores transitorios y respeto de `Retry-After`. `main-page-parser.ts` interpreta las tablas por encabezados y descubre los enlaces históricos. `history-parser.ts` procesa el formulario y los POST históricos con validaciones de fecha y número. `use-cases.ts` coordina descubrimiento, sincronización reciente y backfill. `repository.ts` crea las tablas SQLite, hace UPSERT idempotente y registra cambios de contenido.

La persistencia usa Supabase/PostgreSQL. La migración `supabase/migrations/202607230001_draw_results.sql` crea `draw_games`, `draw_results`, `draw_result_changes` y `draw_ingestion_runs`. Las fechas se envían como `YYYY-MM-DD`, evitando conversiones UTC accidentales para `America/Bogota`.

## Configuración

Variables disponibles:

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

## Comandos

```bash
pnpm install
pnpm scrape:jer:discover
pnpm scrape:jer:latest
pnpm scrape:jer:backfill --game=CHONTICO_DIA
pnpm scrape:jer:backfill --game=CHONTICO_DIA --from=2024-01-01 --to=2026-07-23
pnpm scrape:jer:backfill --games=CHONTICO_DIA,CHONTICO_NOCHE
```

El backfill consulta el catálogo y la página individual una sola vez por juego, omite fechas existentes y guarda cada POST inmediatamente. Si se detiene, se reanuda ejecutando el mismo comando. Los errores se incluyen en el resumen y dejan la ejecución como `PARTIAL`; no se paralelizan fechas.

## Parsers y mantenimiento

El catálogo no contiene una lista fija: se obtiene de `a.botonres_vmas` y de enlaces bajo `/resultados/`, usando el slug como código estable. La clasificación distingue loterías, chances, Astro y Dupla mediante slug/nombre. Para agregar una estructura nueva, primero añade una estrategia validada en `JerHistoryParser`, sus fixtures y una prueba; ante HTML desconocido se lanza un error y no se inserta el resultado.

El HTML externo puede cambiar sin aviso. Revisá `draw_ingestion_runs` y el resumen de la CLI para detectar filas rechazadas, fechas no procesadas o cambios de `sourceHash`. Los cambios de un resultado existente se guardan en `draw_result_changes` antes de actualizar el registro actual. El rate limiting predeterminado es deliberadamente conservador: una solicitud simultánea por dominio y cinco segundos entre solicitudes.
