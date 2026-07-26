-- Additive operational controls for the single JER source. Database time and row locks
-- make this safe across independently running scraper processes.
create table public.scraping_source_states (
  source_code text primary key,
  source_host text not null,
  state text not null default 'ACTIVE' check (state in ('ACTIVE','RATE_LIMITED','BLOCKED','DISABLED')),
  cooldown_until timestamptz,
  last_http_status integer,
  last_error text,
  consecutive_rate_limits integer not null default 0 check (consecutive_rate_limits >= 0),
  owner_token uuid,
  lease_expires_at timestamptz,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  check (source_code = 'JER' and source_host = 'jer.com.co'),
  check ((owner_token is null) = (lease_expires_at is null))
);

insert into public.scraping_source_states (source_code, source_host)
values ('JER', 'jer.com.co') on conflict (source_code) do nothing;

alter table public.draw_ingestion_runs drop constraint if exists draw_ingestion_runs_status_check;
alter table public.draw_ingestion_runs add constraint draw_ingestion_runs_status_check
  check (status in ('RUNNING','PAUSED','SUCCESS','PARTIAL','FAILED','BLOCKED','CANCELLED'));
alter table public.draw_ingestion_runs
  add column if not exists source_code text not null default 'JER',
  add column if not exists attempted_results integer not null default 0 check (attempted_results >= 0),
  add column if not exists failed_results integer not null default 0 check (failed_results >= 0),
  add column if not exists current_batch integer not null default 0 check (current_batch >= 0),
  add column if not exists processed_batches integer not null default 0 check (processed_batches >= 0),
  add column if not exists total_missing integer not null default 0 check (total_missing >= 0),
  add column if not exists last_processed_at timestamptz,
  add column if not exists next_pending_date date,
  add column if not exists last_http_status integer,
  add column if not exists last_error text,
  add column if not exists blocked_until timestamptz,
  add column if not exists status_history jsonb not null default '[]'::jsonb,
  add column if not exists owner_token uuid,
  add column if not exists version bigint not null default 0 check (version >= 0),
  add column if not exists request_token uuid;
alter table public.draw_ingestion_runs add constraint draw_ingestion_runs_source_code_check check (source_code = 'JER') not valid;
alter table public.draw_ingestion_runs validate constraint draw_ingestion_runs_source_code_check;

create index if not exists draw_ingestion_runs_jer_resume_idx
  on public.draw_ingestion_runs (source_code, status, started_at desc);
create index if not exists draw_ingestion_runs_jer_owner_idx
  on public.draw_ingestion_runs (owner_token) where owner_token is not null;

alter table public.scraping_source_states enable row level security;
revoke all on table public.scraping_source_states from public, anon, authenticated;
revoke all on table public.draw_ingestion_runs from anon, authenticated;

create or replace function public.jer_acquire_and_gate(p_owner_token uuid, p_lease_duration_ms integer)
returns table(acquired boolean, state text, cooldown_until timestamptz, lease_expires_at timestamptz, version bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_state public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp();
begin
  if p_owner_token is null or p_lease_duration_ms not between 30000 and 900000 then raise exception 'invalid JER lease request'; end if;
  select * into v_state from public.scraping_source_states where source_code = 'JER' for update;
  if v_state.state in ('BLOCKED','RATE_LIMITED') and v_state.cooldown_until <= v_now then
    update public.scraping_source_states set state='ACTIVE', cooldown_until=null, consecutive_rate_limits=0, updated_at=v_now, version=version+1 where source_code='JER' returning * into v_state;
  end if;
  if v_state.state <> 'ACTIVE' or (v_state.lease_expires_at is not null and v_state.lease_expires_at > v_now and v_state.owner_token <> p_owner_token) then
    return query select false, v_state.state, v_state.cooldown_until, v_state.lease_expires_at, v_state.version; return;
  end if;
  update public.scraping_source_states set owner_token=p_owner_token, lease_expires_at=v_now + make_interval(secs => p_lease_duration_ms::numeric / 1000), updated_at=v_now, version=version+1 where source_code='JER' returning * into v_state;
  return query select true, v_state.state, v_state.cooldown_until, v_state.lease_expires_at, v_state.version;
end $$;

create or replace function public.jer_renew_lease(p_owner_token uuid, p_lease_duration_ms integer)
returns table(renewed boolean, lease_expires_at timestamptz, version bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_state public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp();
begin
  if p_lease_duration_ms not between 30000 and 900000 then raise exception 'invalid JER lease duration'; end if;
  select * into v_state from public.scraping_source_states where source_code='JER' for update;
  if v_state.owner_token is distinct from p_owner_token or v_state.lease_expires_at <= v_now then return query select false, v_state.lease_expires_at, v_state.version; return; end if;
  update public.scraping_source_states set lease_expires_at=v_now + make_interval(secs => p_lease_duration_ms::numeric / 1000), updated_at=v_now, version=version+1 where source_code='JER' returning * into v_state;
  return query select true, v_state.lease_expires_at, v_state.version;
end $$;

create or replace function public.jer_release_lease(p_owner_token uuid)
returns table(released boolean, version bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_state public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp();
begin
  select * into v_state from public.scraping_source_states where source_code='JER' for update;
  if v_state.owner_token is distinct from p_owner_token or v_state.lease_expires_at <= v_now then return query select false, v_state.version; return; end if;
  update public.scraping_source_states set owner_token=null, lease_expires_at=null, updated_at=v_now, version=version+1 where source_code='JER' returning * into v_state;
  return query select true, v_state.version;
end $$;

create or replace function public.jer_transition_403(p_owner_token uuid, p_run_id uuid, p_cooldown_ms integer, p_error text default null)
returns table(transitioned boolean, blocked_until timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_state public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp(); v_until timestamptz;
begin
  if p_cooldown_ms not between 3600000 and 86400000 then raise exception 'invalid JER block cooldown'; end if;
  select * into v_state from public.scraping_source_states where source_code='JER' for update;
  if v_state.owner_token is distinct from p_owner_token or v_state.lease_expires_at <= v_now then return query select false, v_state.cooldown_until; return; end if;
  v_until := v_now + make_interval(secs => p_cooldown_ms::numeric / 1000);
  update public.scraping_source_states set state='BLOCKED', cooldown_until=v_until, last_http_status=403, last_error=p_error, owner_token=null, lease_expires_at=null, updated_at=v_now, version=version+1 where source_code='JER';
  update public.draw_ingestion_runs set status='BLOCKED', blocked_until=v_until, last_http_status=403, last_error=p_error, finished_at=v_now, status_history=status_history || jsonb_build_array(jsonb_build_object('status','BLOCKED','at',v_now)), version=version+1 where id=p_run_id and owner_token=p_owner_token;
  return query select true, v_until;
end $$;

create or replace function public.jer_transition_429(p_owner_token uuid, p_run_id uuid, p_cooldown_ms integer, p_error text default null)
returns table(transitioned boolean, cooldown_until timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_state public.scraping_source_states%rowtype; v_now timestamptz := clock_timestamp(); v_until timestamptz;
begin
  if p_cooldown_ms not between 60000 and 86400000 then raise exception 'invalid JER rate cooldown'; end if;
  select * into v_state from public.scraping_source_states where source_code='JER' for update;
  if v_state.owner_token is distinct from p_owner_token or v_state.lease_expires_at <= v_now then return query select false, v_state.cooldown_until; return; end if;
  v_until := greatest(coalesce(v_state.cooldown_until, v_now), v_now + make_interval(secs => p_cooldown_ms::numeric / 1000));
  update public.scraping_source_states set state='RATE_LIMITED', cooldown_until=v_until, last_http_status=429, last_error=p_error, consecutive_rate_limits=consecutive_rate_limits+1, owner_token=null, lease_expires_at=null, updated_at=v_now, version=version+1 where source_code='JER';
  update public.draw_ingestion_runs set status='PAUSED', blocked_until=v_until, last_http_status=429, last_error=p_error, status_history=status_history || case when status='PAUSED' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('status','PAUSED','at',v_now)) end, version=version+1 where id=p_run_id and owner_token=p_owner_token;
  return query select true, v_until;
end $$;

create or replace function public.jer_save_progress(p_run_id uuid, p_owner_token uuid, p_version bigint, p_request_token uuid, p_status text, p_attempted integer, p_inserted integer, p_updated integer, p_skipped integer, p_failed integer, p_next_pending_date date default null)
returns table(accepted boolean, duplicate boolean, version bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare v_run public.draw_ingestion_runs%rowtype; v_now timestamptz := clock_timestamp();
begin
  select * into v_run from public.draw_ingestion_runs where id=p_run_id for update;
  if not found then raise exception 'run not found'; end if;
  if v_run.owner_token is distinct from p_owner_token then raise exception 'stale progress owner'; end if;
  if p_status not in ('RUNNING','PAUSED','SUCCESS','PARTIAL','FAILED','BLOCKED','CANCELLED') then raise exception 'invalid run status'; end if;
  if p_version = v_run.version and p_request_token = v_run.request_token then
    if v_run.status = p_status
      and v_run.attempted_results = p_attempted
      and v_run.results_inserted = p_inserted
      and v_run.results_updated = p_updated
      and v_run.results_skipped = p_skipped
      and v_run.failed_results = p_failed
      and v_run.next_pending_date is not distinct from p_next_pending_date then
      return query select true, true, v_run.version; return;
    end if;
    raise exception 'conflicting duplicate progress request';
  end if;
  if p_version <> v_run.version + 1 or p_request_token is null then raise exception 'stale progress version or request token'; end if;
  update public.draw_ingestion_runs set status=p_status, attempted_results=p_attempted, results_inserted=p_inserted, results_updated=p_updated, results_skipped=p_skipped, failed_results=p_failed, next_pending_date=p_next_pending_date, last_processed_at=v_now, request_token=p_request_token, version=p_version, status_history=status_history || case when status=p_status then '[]'::jsonb else jsonb_build_array(jsonb_build_object('status',p_status,'at',v_now)) end where id=p_run_id;
  return query select true, false, p_version;
end $$;

revoke all on function public.jer_acquire_and_gate(uuid, integer) from public, anon, authenticated;
revoke all on function public.jer_renew_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.jer_release_lease(uuid) from public, anon, authenticated;
revoke all on function public.jer_transition_403(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.jer_transition_429(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.jer_save_progress(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date) from public, anon, authenticated;
grant execute on function public.jer_acquire_and_gate(uuid, integer) to service_role;
grant execute on function public.jer_renew_lease(uuid, integer) to service_role;
grant execute on function public.jer_release_lease(uuid) to service_role;
grant execute on function public.jer_transition_403(uuid, uuid, integer, text) to service_role;
grant execute on function public.jer_transition_429(uuid, uuid, integer, text) to service_role;
grant execute on function public.jer_save_progress(uuid, uuid, bigint, uuid, text, integer, integer, integer, integer, integer, date) to service_role;
