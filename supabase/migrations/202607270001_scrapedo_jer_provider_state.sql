-- Additive Scrape.do-only run state. Existing direct runs retain NULL state.
alter table public.draw_ingestion_runs
  add column if not exists provider_state jsonb;

create index if not exists draw_ingestion_runs_scrapedo_resume_idx
  on public.draw_ingestion_runs (source_code, status, last_processed_at desc nulls last, started_at desc, id desc)
  where provider_state is not null and finished_at is null;

create or replace function public.jer_is_valid_scrapedo_provider_state(p_provider_state jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_session_id text;
  v_blocked_count text;
begin
  if jsonb_typeof(p_provider_state) <> 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(p_provider_state)) <> 8 then return false; end if;
  if not p_provider_state ?& array['schemaVersion', 'provider', 'targetOrigin', 'tier', 'sessionId', 'sessionStatus', 'standardBlockedSessionCount', 'pendingSuper'] then return false; end if;
  if jsonb_typeof(p_provider_state->'schemaVersion') <> 'number' then return false; end if;
  if p_provider_state->>'schemaVersion' <> '1' then return false; end if;
  if jsonb_typeof(p_provider_state->'provider') <> 'string' then return false; end if;
  if p_provider_state->>'provider' <> 'SCRAPEDO' then return false; end if;
  if jsonb_typeof(p_provider_state->'targetOrigin') <> 'string' then return false; end if;
  if p_provider_state->>'targetOrigin' <> 'https://jer.com.co' then return false; end if;
  if jsonb_typeof(p_provider_state->'tier') <> 'string' then return false; end if;
  if p_provider_state->>'tier' not in ('STANDARD', 'SUPER') then return false; end if;
  if jsonb_typeof(p_provider_state->'sessionId') = 'null' then
    if p_provider_state->>'tier' <> 'STANDARD' or p_provider_state->>'sessionStatus' <> 'INVALID' or p_provider_state->>'standardBlockedSessionCount' <> '0' or p_provider_state->>'pendingSuper' <> 'false' then return false; end if;
  elsif jsonb_typeof(p_provider_state->'sessionId') = 'number' then
    v_session_id := p_provider_state->>'sessionId';
    if v_session_id !~ '^\d+$' then return false; end if;
    if length(v_session_id) > 7 then return false; end if;
    if v_session_id::numeric not between 0 and 1000000 then return false; end if;
  else return false; end if;
  if jsonb_typeof(p_provider_state->'sessionStatus') <> 'string' then return false; end if;
  if p_provider_state->>'sessionStatus' not in ('ACTIVE', 'INVALID') then return false; end if;
  if jsonb_typeof(p_provider_state->'standardBlockedSessionCount') <> 'number' then return false; end if;
  v_blocked_count := p_provider_state->>'standardBlockedSessionCount';
  if v_blocked_count !~ '^\d+$' then return false; end if;
  if length(v_blocked_count) > 1000 then return false; end if;
  if v_blocked_count::numeric < 0 then return false; end if;
  if jsonb_typeof(p_provider_state->'pendingSuper') <> 'boolean' then return false; end if;
  return true;
end;
$$;

create or replace function public.jer_start_or_resume_scrapedo_backfill(p_owner_token uuid)
returns table(run_id uuid, provider_state jsonb, version bigint, request_token uuid)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_source public.scraping_source_states%rowtype;
  v_run public.draw_ingestion_runs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_state jsonb;
  v_request_token uuid := gen_random_uuid();
begin
  if p_owner_token is null then raise exception 'invalid JER lease owner'; end if;
  select * into v_source from public.scraping_source_states where source_code = 'JER' for update;
  if not found then raise exception 'JER source state not found'; end if;
  if v_source.state <> 'ACTIVE' or v_source.owner_token is distinct from p_owner_token or v_source.lease_expires_at <= v_now then
    raise exception 'inactive or stale JER lease';
  end if;

  select * into v_run from public.draw_ingestion_runs
  where source_code = 'JER' and run_type = 'BACKFILL' and finished_at is null and status in ('RUNNING', 'PAUSED')
    and provider_state is not null and public.jer_is_valid_scrapedo_provider_state(provider_state)
  order by last_processed_at desc nulls last, started_at desc, id desc
  limit 1 for update;

  if found then
    update public.draw_ingestion_runs set owner_token = p_owner_token, version = version + 1, request_token = v_request_token
    where id = v_run.id returning * into v_run;
    return query select v_run.id, v_run.provider_state, v_run.version, v_run.request_token;
    return;
  end if;

  select provider_state into v_state from public.draw_ingestion_runs
  where source_code = 'JER' and run_type = 'BACKFILL' and finished_at is not null
    and provider_state is not null and public.jer_is_valid_scrapedo_provider_state(provider_state)
  order by finished_at desc, id desc limit 1 for update;
  if v_state is null then
    v_state := jsonb_build_object('schemaVersion', 1, 'provider', 'SCRAPEDO', 'targetOrigin', 'https://jer.com.co', 'tier', 'STANDARD', 'sessionId', null, 'sessionStatus', 'INVALID', 'standardBlockedSessionCount', 0, 'pendingSuper', false);
  end if;
  insert into public.draw_ingestion_runs (run_type, status, source_code, owner_token, version, request_token, provider_state)
  values ('BACKFILL', 'RUNNING', 'JER', p_owner_token, 1, v_request_token, v_state)
  returning * into v_run;
  return query select v_run.id, v_run.provider_state, v_run.version, v_run.request_token;
end $$;

create or replace function public.jer_save_progress_with_provider_state(p_run_id uuid, p_owner_token uuid, p_version bigint, p_request_token uuid, p_status text, p_attempted integer, p_inserted integer, p_updated integer, p_skipped integer, p_failed integer, p_next_pending_date date, p_provider_state jsonb)
returns table(accepted boolean, duplicate boolean, run_id uuid, version bigint, request_token uuid, provider_state jsonb)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_run public.draw_ingestion_runs%rowtype; v_source public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp();
begin
  if not coalesce(public.jer_is_valid_scrapedo_provider_state(p_provider_state), false) then raise exception 'invalid Scrape.do provider state'; end if;
  select * into v_source from public.scraping_source_states where source_code = 'JER' for update;
  if not found then raise exception 'JER source state not found'; end if;
  if v_source.state <> 'ACTIVE' or v_source.owner_token is distinct from p_owner_token or v_source.lease_expires_at <= v_now then raise exception 'stale progress owner'; end if;
  select * into v_run from public.draw_ingestion_runs where id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;
  if v_run.owner_token is distinct from p_owner_token then raise exception 'stale progress owner'; end if;
  if p_status not in ('RUNNING','PAUSED','SUCCESS','PARTIAL','FAILED','BLOCKED','CANCELLED') then raise exception 'invalid run status'; end if;
  if p_version = v_run.version and p_request_token = v_run.request_token then
    if v_run.status = p_status and v_run.attempted_results = p_attempted and v_run.results_inserted = p_inserted
      and v_run.results_updated = p_updated and v_run.results_skipped = p_skipped and v_run.failed_results = p_failed
      and v_run.next_pending_date is not distinct from p_next_pending_date and v_run.provider_state is not distinct from p_provider_state then
      return query select true, true, v_run.id, v_run.version, v_run.request_token, v_run.provider_state; return;
    end if;
    raise exception 'conflicting duplicate progress request';
  end if;
  if p_version <> v_run.version + 1 or p_request_token is null then raise exception 'stale progress version or request token'; end if;
  update public.draw_ingestion_runs set status=p_status, attempted_results=p_attempted, results_inserted=p_inserted,
    results_updated=p_updated, results_skipped=p_skipped, failed_results=p_failed, next_pending_date=p_next_pending_date,
    last_processed_at=v_now, request_token=p_request_token, provider_state=p_provider_state, version=p_version,
    status_history=status_history || case when status=p_status then '[]'::jsonb else jsonb_build_array(jsonb_build_object('status',p_status,'at',v_now)) end
  where id=p_run_id returning * into v_run;
  return query select true, false, v_run.id, v_run.version, v_run.request_token, v_run.provider_state;
end $$;

revoke all on function public.jer_is_valid_scrapedo_provider_state(jsonb) from public, anon, authenticated;
revoke all on function public.jer_start_or_resume_scrapedo_backfill(uuid) from public, anon, authenticated;
revoke all on function public.jer_save_progress_with_provider_state(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date, jsonb) from public, anon, authenticated;
grant execute on function public.jer_start_or_resume_scrapedo_backfill(uuid) to service_role;
grant execute on function public.jer_save_progress_with_provider_state(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date, jsonb) to service_role;

-- Rollback strategy: retain this inert additive column and RPC surface; disable callers/configuration.
