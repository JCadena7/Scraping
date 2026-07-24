create table if not exists public.draw_games (
  id uuid primary key default gen_random_uuid(),
  external_code text not null unique,
  name text not null,
  type text not null check (type in ('LOTTERY','CHANCE','ASTRO','DUPLA','OTHER')),
  detail_url text not null unique,
  source text not null default 'jer',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.draw_results (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.draw_games(id),
  draw_date date not null,
  draw_number text,
  winning_number text not null check (winning_number ~ '^[0-9]+$'),
  fifth_digit text check (fifth_digit is null or fifth_digit ~ '^[0-9]$'),
  series text,
  zodiac_sign text,
  source_url text not null,
  source_hash text not null,
  fetched_at timestamptz not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, draw_date)
);

create table if not exists public.draw_result_changes (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.draw_results(id),
  changed_at timestamptz not null default now(),
  previous_hash text not null,
  previous_winning_number text not null,
  new_hash text not null,
  new_winning_number text not null
);

create table if not exists public.draw_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  games_queried integer not null default 0,
  dates_queried integer not null default 0,
  results_found integer not null default 0,
  results_inserted integer not null default 0,
  results_updated integer not null default 0,
  results_skipped integer not null default 0,
  errors jsonb not null default '[]'::jsonb
);

create index if not exists draw_results_game_date_idx on public.draw_results(game_id, draw_date);

create or replace function public.set_draw_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists draw_games_updated_at on public.draw_games;
create trigger draw_games_updated_at before update on public.draw_games
for each row execute function public.set_draw_updated_at();

drop trigger if exists draw_results_updated_at on public.draw_results;
create trigger draw_results_updated_at before update on public.draw_results
for each row execute function public.set_draw_updated_at();
