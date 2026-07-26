alter table public.draw_games enable row level security;
alter table public.draw_results enable row level security;
alter table public.draw_result_changes enable row level security;
alter table public.draw_ingestion_runs enable row level security;

revoke all on table public.draw_games from anon, authenticated;
revoke all on table public.draw_results from anon, authenticated;
revoke all on table public.draw_result_changes from anon, authenticated;
revoke all on table public.draw_ingestion_runs from anon, authenticated;
revoke insert, update, delete on table public.draw_results from service_role;
revoke insert, update, delete on table public.draw_result_changes from service_role;

grant select, insert, update on table public.draw_games to service_role;
grant select on table public.draw_results to service_role;
grant insert, update on table public.draw_ingestion_runs to service_role;

create or replace function public.upsert_draw_result(
  p_game_code text,
  p_draw_date date,
  p_draw_number text,
  p_winning_number text,
  p_fifth_digit text,
  p_series text,
  p_zodiac_sign text,
  p_source_url text,
  p_source_hash text,
  p_fetched_at timestamptz,
  p_verified boolean
)
returns table(action text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_game_id uuid;
  v_result_id uuid;
  v_existing_hash text;
  v_existing_winning_number text;
begin
  if p_source_hash !~ '^v2:' then
    raise exception 'source hash must use the v2 format';
  end if;

  select id into v_game_id
  from public.draw_games
  where external_code = p_game_code;
  if not found then
    raise exception 'game not found in catalog: %', p_game_code;
  end if;

  insert into public.draw_results (
    game_id, draw_date, draw_number, winning_number, fifth_digit, series,
    zodiac_sign, source_url, source_hash, fetched_at, verified
  ) values (
    v_game_id, p_draw_date, p_draw_number, p_winning_number, p_fifth_digit, p_series,
    p_zodiac_sign, p_source_url, p_source_hash, p_fetched_at, p_verified
  ) on conflict (game_id, draw_date) do nothing
  returning id into v_result_id;

  if found then
    return query select 'inserted'::text;
    return;
  end if;

  select id, source_hash, winning_number
  into v_result_id, v_existing_hash, v_existing_winning_number
  from public.draw_results
  where game_id = v_game_id and draw_date = p_draw_date
  for update;

  if v_existing_hash not like 'v2:%' then
    update public.draw_results
    set draw_number = p_draw_number, winning_number = p_winning_number, fifth_digit = p_fifth_digit,
        series = p_series, zodiac_sign = p_zodiac_sign, source_url = p_source_url,
        source_hash = p_source_hash, fetched_at = p_fetched_at, verified = p_verified
    where id = v_result_id;
    return query select 'rebaselined'::text;
    return;
  end if;

  if v_existing_hash = p_source_hash then
    return query select 'skipped'::text;
    return;
  end if;

  insert into public.draw_result_changes (
    result_id, previous_hash, previous_winning_number, new_hash, new_winning_number
  ) values (
    v_result_id, v_existing_hash, v_existing_winning_number, p_source_hash, p_winning_number
  );

  update public.draw_results
  set draw_number = p_draw_number, winning_number = p_winning_number, fifth_digit = p_fifth_digit,
      series = p_series, zodiac_sign = p_zodiac_sign, source_url = p_source_url,
      source_hash = p_source_hash, fetched_at = p_fetched_at, verified = p_verified
  where id = v_result_id;

  return query select 'updated'::text;
end;
$$;

revoke all on function public.upsert_draw_result(text, date, text, text, text, text, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.upsert_draw_result(text, date, text, text, text, text, text, text, text, timestamptz, boolean) to service_role;

create or replace function public.preserve_jer_draw_number()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.draw_number is null and old.draw_number is not null then
    new.draw_number := old.draw_number;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_jer_draw_number on public.draw_results;

create trigger preserve_jer_draw_number
before update on public.draw_results
for each row execute function public.preserve_jer_draw_number();
