-- Initial migration created with the Supabase CLI.
-- Executed transactionally. Public writes use narrow RPCs; the browser never reads Vault.
begin;
create schema if not exists private;
create extension if not exists supabase_vault with schema vault;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
revoke all on schema vault from public, anon, authenticated;
revoke all on all tables in schema vault from public, anon, authenticated;
-- Hosted Vault crypto routines belong to supabase_admin. Preserve their managed
-- ACLs; the schema and table revocations above deny all direct browser access.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  capacity integer not null default 3 check (capacity between 1 and 1000),
  duoplus_interval_ms integer not null default 1200 check (duoplus_interval_ms between 1200 and 60000),
  telemetry_interval_ms integer not null default 7000 check (telemetry_interval_ms between 5000 and 3600000),
  history_retention_days integer not null default 30 check (history_retention_days between 1 and 365),
  created_at timestamptz not null default now()
);
create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id,user_id)
);
create index org_members_user_idx on public.org_members(user_id,org_id);
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('duoplus','wigle')),
  key_alias text not null check (char_length(btrim(key_alias)) between 1 and 100),
  status text not null default 'untested' check (status in ('ready','rate_limited','invalid','untested')),
  last_used_at timestamptz,
  rate_limit_reset_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id,id), unique (org_id,provider,key_alias)
);
create table private.credential_secrets (
  key_id uuid primary key,
  org_id uuid not null,
  vault_secret_id uuid not null unique references vault.secrets(id),
  foreign key (org_id,key_id) references public.api_keys(org_id,id) on delete cascade
);
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  station_code text not null check (char_length(station_code) between 1 and 64),
  duoplus_device_id text not null check (char_length(duoplus_device_id) between 1 and 128),
  status text not null default 'OFFLINE' check (status in ('STATIONARY','NAVIGATING','OFFLINE')),
  mode text not null default 'SIMULATION' check (mode in ('LIVE','SIMULATION')),
  is_powered boolean not null default false,
  ticks_enabled boolean not null default false,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  anchor_lat double precision not null check (anchor_lat between -90 and 90),
  anchor_lng double precision not null check (anchor_lng between -180 and 180),
  s2_cell_id text not null,
  altitude double precision not null default 0,
  accuracy_meters double precision not null default 15 check (accuracy_meters between 0 and 10000),
  speed double precision not null default 0 check (speed >= 0 and speed <= 1000),
  bearing double precision not null default 0 check (bearing >= 0 and bearing < 360),
  ssid text, bssid text, mcc_mnc text,
  signal_dbm integer check (signal_dbm between -150 and 0),
  environment_status text not null default 'pending' check (environment_status in ('pending','syncing','synced','partial','no_results','failed')),
  environment_version integer not null default 1 check (environment_version >= 1),
  environment_synced_at timestamptz,
  environment_refresh_enabled boolean not null default false,
  environment_radius_meters integer not null default 200 check (environment_radius_meters between 25 and 1000),
  route jsonb not null default '[]'::jsonb check (jsonb_typeof(route) = 'array'),
  route_progress_meters double precision not null default 0 check (route_progress_meters >= 0),
  route_speed_mps double precision not null default 1.4 check (route_speed_mps between 0.1 and 55),
  control_version integer not null default 1 check (control_version >= 1),
  identity_locked_at timestamptz,
  identity_status text not null default 'unverified' check (identity_status in ('unverified','locked','drift')),
  identity_changed_fields text[] not null default '{}',
  last_error text, last_tick_at timestamptz,
  updated_at timestamptz not null default now(), created_at timestamptz not null default now(),
  unique (org_id,id), unique (org_id,station_code), unique (org_id,duoplus_device_id)
);
create table private.device_identity_locks (
  device_id uuid primary key, org_id uuid not null,
  vault_secret_id uuid not null unique references vault.secrets(id),
  created_at timestamptz not null default now(),
  foreign key (org_id,device_id) references public.devices(org_id,id) on delete cascade
);
create table public.telemetry_ticks (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  org_id uuid not null,
  device_id uuid not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_meters double precision not null check (accuracy_meters between 0 and 10000),
  provider text not null,
  source text not null check (source in ('simulated','command_accepted')),
  created_at timestamptz not null default now(),
  foreign key (org_id,device_id) references public.devices(org_id,id) on delete cascade
);
create index telemetry_ticks_org_device_time_idx on public.telemetry_ticks(org_id,device_id,created_at desc);
create index telemetry_ticks_retention_idx on public.telemetry_ticks(created_at);
create table public.rpa_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  duoplus_template_id text not null check (char_length(duoplus_template_id) between 1 and 128),
  template_type integer not null default 2 check (template_type in (1,2)),
  variables jsonb not null default '{}'::jsonb check (jsonb_typeof(variables) = 'object' and octet_length(variables::text) <= 60000),
  created_at timestamptz not null default now(),
  unique (org_id,id)
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid,
  kind text not null check (kind in ('environment_sync','device_sync','rpa','power_on','power_off')),
  status text not null default 'pending' check (status in ('pending','queued','running','completed','failed')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 60000),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id,id),
  foreign key (org_id,device_id) references public.devices(org_id,id) on delete cascade,
  check (kind = 'device_sync' or device_id is not null)
);
create index jobs_pending_idx on public.jobs(status,created_at) where status in ('pending','queued','running');
create index jobs_org_time_idx on public.jobs(org_id,created_at desc);
create unique index jobs_active_environment_idx on public.jobs(device_id,(payload->>'environment_version'))
  where kind='environment_sync' and status in ('pending','queued','running');
create unique index jobs_active_power_idx on public.jobs(device_id)
  where kind in ('power_on','power_off') and status in ('pending','queued','running');
create table public.job_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  job_id uuid not null,
  attempt integer not null check (attempt >= 1),
  status text not null check (status in ('running','completed','failed')),
  error text,
  started_at timestamptz not null default now(), finished_at timestamptz,
  foreign key (org_id,job_id) references public.jobs(org_id,id) on delete cascade
);
create index job_attempts_org_job_idx on public.job_attempts(org_id,job_id,started_at desc);
create table public.environment_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  device_id uuid not null,
  environment_version integer not null,
  target_lat double precision not null check (target_lat between -90 and 90),
  target_lng double precision not null check (target_lng between -180 and 180),
  radius_meters integer not null,
  ssid text, bssid text, mcc_mnc text,
  wifi jsonb, cell jsonb,
  status text not null check (status in ('synced','partial','no_results')),
  source text not null default 'wigle',
  synced_at timestamptz not null default now(), created_at timestamptz not null default now(),
  unique (device_id,environment_version),
  foreign key (org_id,device_id) references public.devices(org_id,id) on delete cascade
);
create index environment_snapshots_org_device_idx on public.environment_snapshots(org_id,device_id,created_at desc);

-- A tenant identifier can never be reassigned, including by the service worker.
create function private.immutable_org_id() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is distinct from old.org_id then raise exception 'Tenant identity is immutable' using errcode='42501'; end if;
  return new;
end $$;
create function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create function private.is_member(p_org_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = (select auth.uid()));
$$;
create function private.require_admin(p_org_id uuid) returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=auth.uid() and m.role in ('owner','admin')) then
    raise exception 'Workspace administrator required' using errcode='42501';
  end if;
end $$;

-- Every exposed table has RLS. Authenticated clients have read access only;
-- mutations below recheck membership inside the transaction, eliminating TOCTOU gaps.
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.api_keys enable row level security;
alter table public.devices enable row level security;
alter table public.telemetry_ticks enable row level security;
alter table public.rpa_templates enable row level security;
alter table public.jobs enable row level security;
alter table public.job_attempts enable row level security;
alter table public.environment_snapshots enable row level security;
alter table private.credential_secrets enable row level security;
alter table private.device_identity_locks enable row level security;
create policy organizations_member_read on public.organizations for select to authenticated using (private.is_member(id));
create policy org_members_member_read on public.org_members for select to authenticated using (private.is_member(org_id));
create policy api_keys_member_read on public.api_keys for select to authenticated using (private.is_member(org_id));
create policy devices_member_read on public.devices for select to authenticated using (private.is_member(org_id));
create policy telemetry_ticks_member_read on public.telemetry_ticks for select to authenticated using (private.is_member(org_id));
create policy rpa_templates_member_read on public.rpa_templates for select to authenticated using (private.is_member(org_id));
create policy jobs_member_read on public.jobs for select to authenticated using (private.is_member(org_id));
create policy job_attempts_member_read on public.job_attempts for select to authenticated using (private.is_member(org_id));
create policy environment_snapshots_member_read on public.environment_snapshots for select to authenticated using (private.is_member(org_id));

create trigger api_keys_immutable_org before update on public.api_keys for each row execute function private.immutable_org_id();
create trigger org_members_immutable_org before update on public.org_members for each row execute function private.immutable_org_id();
create trigger devices_immutable_org before update on public.devices for each row execute function private.immutable_org_id();
create trigger ticks_immutable_org before update on public.telemetry_ticks for each row execute function private.immutable_org_id();
create trigger jobs_immutable_org before update on public.jobs for each row execute function private.immutable_org_id();
create trigger attempts_immutable_org before update on public.job_attempts for each row execute function private.immutable_org_id();
create trigger templates_immutable_org before update on public.rpa_templates for each row execute function private.immutable_org_id();
create trigger snapshots_immutable_org before update on public.environment_snapshots for each row execute function private.immutable_org_id();
create trigger credentials_immutable_org before update on private.credential_secrets for each row execute function private.immutable_org_id();
create trigger devices_updated before update on public.devices for each row execute function private.touch_updated_at();
create trigger jobs_updated before update on public.jobs for each row execute function private.touch_updated_at();

create function private.create_organization(p_name text) returns public.organizations language plpgsql security definer set search_path = '' as $$
declare v_org public.organizations;
begin
  if auth.uid() is null or not exists(select 1 from auth.users where id=auth.uid() and coalesce(is_anonymous,false)=false) then raise exception 'Email authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if (select count(*) from public.org_members where user_id=auth.uid() and role='owner') >= 20 then raise exception 'Workspace limit reached' using errcode='22023'; end if;
  insert into public.organizations(name) values(btrim(p_name)) returning * into v_org;
  insert into public.org_members(org_id,user_id,role) values(v_org.id,auth.uid(),'owner');
  return v_org;
end $$;
create function public.create_organization(p_name text) returns public.organizations language sql security invoker set search_path = '' as $$select private.create_organization(p_name)$$;

create function private.store_credential(p_org_id uuid,p_provider text,p_alias text,p_secret text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid:=gen_random_uuid(); v_secret_id uuid; v_wigle jsonb;
begin
  perform private.require_admin(p_org_id);
  if p_provider not in ('duoplus','wigle') or p_secret is null or length(btrim(p_secret)) not between 1 and 8192 or p_secret ~ '[\r\n]' then raise exception 'Invalid credential' using errcode='22023'; end if;
  if p_provider='wigle' then
    begin v_wigle:=p_secret::jsonb; exception when others then raise exception 'Invalid WiGLE credential' using errcode='22023'; end;
    if jsonb_typeof(v_wigle) <> 'object' or coalesce(v_wigle->>'apiName','') = '' or coalesce(v_wigle->>'apiToken','') = '' or v_wigle->'commercialUseAuthorized' is distinct from 'true'::jsonb then raise exception 'WiGLE commercial authorization required' using errcode='22023'; end if;
  end if;
  insert into public.api_keys(id,org_id,provider,key_alias) values(v_id,p_org_id,p_provider,btrim(p_alias));
  select vault.create_secret(p_secret,'stations:'||v_id::text,'Tenant BYOK credential') into v_secret_id;
  insert into private.credential_secrets(key_id,org_id,vault_secret_id) values(v_id,p_org_id,v_secret_id);
  return v_id;
end $$;
create function public.store_credential(p_org_id uuid,p_provider text,p_alias text,p_secret text) returns uuid language sql security invoker set search_path = '' as $$select private.store_credential(p_org_id,p_provider,p_alias,p_secret)$$;
create function private.delete_credential(p_key_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_secret uuid;
begin
  select org_id into v_org from public.api_keys where id=p_key_id for update;
  if not found then raise exception 'Credential not found' using errcode='P0002'; end if;
  perform private.require_admin(v_org);
  select vault_secret_id into v_secret from private.credential_secrets where key_id=p_key_id and org_id=v_org;
  delete from private.credential_secrets where key_id=p_key_id and org_id=v_org;
  delete from vault.secrets where id=v_secret;
  delete from public.api_keys where id=p_key_id and org_id=v_org;
end $$;
create function public.delete_credential(p_key_id uuid) returns void language sql security invoker set search_path = '' as $$select private.delete_credential(p_key_id)$$;
create function private.get_credential(p_org_id uuid,p_key_id uuid) returns text language sql stable security definer set search_path = '' as $$
  select v.decrypted_secret from private.credential_secrets s
  join public.api_keys k on k.id=s.key_id and k.org_id=s.org_id
  join vault.decrypted_secrets v on v.id=s.vault_secret_id
  where s.org_id=p_org_id and s.key_id=p_key_id;
$$;
create function public.get_credential(p_org_id uuid,p_key_id uuid) returns text language sql stable security invoker set search_path = '' as $$select private.get_credential(p_org_id,p_key_id)$$;

-- This trigger atomically creates a durable provisioning job on registration or
-- relocation. A crash between HTTP response and Redis dispatch cannot lose it.
create function private.provision_environment() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' or new.environment_version is distinct from old.environment_version then
    insert into public.jobs(org_id,device_id,kind,payload) values(new.org_id,new.id,'environment_sync',jsonb_build_object('environment_version',new.environment_version,'target_lat',new.anchor_lat,'target_lng',new.anchor_lng));
  end if;
  return new;
end $$;
create trigger provision_environment after insert or update of environment_version on public.devices for each row execute function private.provision_environment();
create function private.register_station(p_org_id uuid,p_station_code text,p_duoplus_device_id text,p_lat double precision,p_lng double precision,p_mode text,p_s2_cell_id text) returns public.devices language plpgsql security definer set search_path = '' as $$
declare v_device public.devices;
begin
  perform private.require_admin(p_org_id);
  insert into public.devices(org_id,station_code,duoplus_device_id,lat,lng,anchor_lat,anchor_lng,mode,s2_cell_id,status,ticks_enabled)
  values(p_org_id,p_station_code,p_duoplus_device_id,p_lat,p_lng,p_lat,p_lng,p_mode,p_s2_cell_id,case when p_mode='SIMULATION' then 'STATIONARY' else 'OFFLINE' end,p_mode='SIMULATION') returning * into v_device;
  return v_device;
end $$;
create function public.register_station(p_org_id uuid,p_station_code text,p_duoplus_device_id text,p_lat double precision,p_lng double precision,p_mode text,p_s2_cell_id text) returns public.devices language sql security invoker set search_path = '' as $$select private.register_station(p_org_id,p_station_code,p_duoplus_device_id,p_lat,p_lng,p_mode,p_s2_cell_id)$$;
create function private.control_station(p_org_id uuid,p_device_id uuid,p_action text,p_lat double precision default null,p_lng double precision default null,p_route jsonb default null,p_route_speed_mps double precision default null,p_s2_cell_id text default null) returns public.devices language plpgsql security definer set search_path = '' as $$
declare v_device public.devices; v_point jsonb;
begin
  perform private.require_admin(p_org_id);
  select * into v_device from public.devices where id=p_device_id and org_id=p_org_id for update;
  if not found then raise exception 'Station not found' using errcode='P0002'; end if;
  if p_action='pause' then
    update public.devices set ticks_enabled=false,control_version=control_version+1 where id=p_device_id and org_id=p_org_id returning * into v_device;
  elsif p_action='resume' then
    update public.devices set ticks_enabled=true,control_version=control_version+1 where id=p_device_id and org_id=p_org_id returning * into v_device;
  elsif p_action='park' then
    update public.devices set status=case when mode='LIVE' and not is_powered then 'OFFLINE' else 'STATIONARY' end,route='[]'::jsonb,route_progress_meters=0,lat=anchor_lat,lng=anchor_lng,speed=0,control_version=control_version+1 where id=p_device_id and org_id=p_org_id returning * into v_device;
  elsif p_action='relocate' then
    if p_lat is null or p_lng is null or p_s2_cell_id is null then raise exception 'Location required' using errcode='22023'; end if;
    update public.devices set lat=p_lat,lng=p_lng,anchor_lat=p_lat,anchor_lng=p_lng,s2_cell_id=p_s2_cell_id,environment_version=environment_version+1,environment_status='pending',environment_synced_at=null,ssid=null,bssid=null,mcc_mnc=null,signal_dbm=null,route='[]'::jsonb,route_progress_meters=0,speed=0,status=case when mode='LIVE' and not is_powered then 'OFFLINE' else 'STATIONARY' end,control_version=control_version+1 where id=p_device_id and org_id=p_org_id returning * into v_device;
  elsif p_action='navigate' then
    if p_route is null or jsonb_typeof(p_route)<>'array' or jsonb_array_length(p_route) not between 2 and 1000 or p_route_speed_mps is null then raise exception 'Route required' using errcode='22023'; end if;
    for v_point in select value from jsonb_array_elements(p_route) loop
      if jsonb_typeof(v_point)<>'array' or jsonb_array_length(v_point)<>2 or jsonb_typeof(v_point->0)<>'number' or jsonb_typeof(v_point->1)<>'number' or (v_point->>0)::double precision not between -180 and 180 or (v_point->>1)::double precision not between -90 and 90 then raise exception 'Invalid route point' using errcode='22023'; end if;
    end loop;
    update public.devices set status='NAVIGATING',route=p_route,route_progress_meters=0,route_speed_mps=p_route_speed_mps,ticks_enabled=true,control_version=control_version+1 where id=p_device_id and org_id=p_org_id returning * into v_device;
  else raise exception 'Unsupported control' using errcode='22023'; end if;
  return v_device;
end $$;
create function public.control_station(p_org_id uuid,p_device_id uuid,p_action text,p_lat double precision default null,p_lng double precision default null,p_route jsonb default null,p_route_speed_mps double precision default null,p_s2_cell_id text default null) returns public.devices language sql security invoker set search_path = '' as $$select private.control_station(p_org_id,p_device_id,p_action,p_lat,p_lng,p_route,p_route_speed_mps,p_s2_cell_id)$$;
create function private.enqueue_job(p_org_id uuid,p_kind text,p_device_id uuid default null,p_payload jsonb default '{}'::jsonb) returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_device public.devices; v_job public.jobs; v_payload jsonb:='{}'::jsonb; v_template public.rpa_templates; v_key uuid;
begin
  perform private.require_admin(p_org_id);
  if p_device_id is not null then
    select * into v_device from public.devices where id=p_device_id and org_id=p_org_id for update;
    if not found then raise exception 'Station not found' using errcode='P0002'; end if;
  elsif p_kind <> 'device_sync' then raise exception 'Station required' using errcode='22023'; end if;
  if p_kind='environment_sync' then
    v_payload:=jsonb_build_object('environment_version',v_device.environment_version,'target_lat',v_device.anchor_lat,'target_lng',v_device.anchor_lng);
    select * into v_job from public.jobs where org_id=p_org_id and device_id=p_device_id and kind=p_kind and status in ('pending','queued','running') and payload->>'environment_version'=v_device.environment_version::text limit 1;
    if found then return v_job; end if;
    update public.devices set environment_status='pending',last_error=null where id=p_device_id and org_id=p_org_id;
  elsif p_kind='device_sync' then
    if p_payload ? 'key_id' then
      v_key:=(p_payload->>'key_id')::uuid;
      if not exists(select 1 from public.api_keys where id=v_key and org_id=p_org_id and provider='duoplus') then raise exception 'DuoPlus key not found' using errcode='P0002'; end if;
      v_payload:=jsonb_build_object('key_id',v_key);
    end if;
  elsif p_kind='rpa' then
    select * into v_template from public.rpa_templates where id=(p_payload->>'template_id')::uuid and org_id=p_org_id;
    if not found then raise exception 'Template not found' using errcode='P0002'; end if;
    v_payload:=jsonb_build_object('template_id',v_template.id);
  elsif p_kind not in ('power_on','power_off') then raise exception 'Unsupported job kind' using errcode='22023'; end if;
  insert into public.jobs(org_id,device_id,kind,payload) values(p_org_id,p_device_id,p_kind,v_payload) returning * into v_job;
  return v_job;
end $$;
create function public.enqueue_job(p_org_id uuid,p_kind text,p_device_id uuid default null,p_payload jsonb default '{}'::jsonb) returns public.jobs language sql security invoker set search_path = '' as $$select private.enqueue_job(p_org_id,p_kind,p_device_id,p_payload)$$;
create function private.create_rpa_template(p_org_id uuid,p_name text,p_duoplus_template_id text,p_variables jsonb,p_template_type integer default 2) returns public.rpa_templates language plpgsql security definer set search_path = '' as $$
declare v_template public.rpa_templates;
begin
  perform private.require_admin(p_org_id);
  insert into public.rpa_templates(org_id,name,duoplus_template_id,variables,template_type) values(p_org_id,p_name,p_duoplus_template_id,p_variables,p_template_type) returning * into v_template;
  return v_template;
end $$;
create function public.create_rpa_template(p_org_id uuid,p_name text,p_duoplus_template_id text,p_variables jsonb,p_template_type integer default 2) returns public.rpa_templates language sql security invoker set search_path = '' as $$select private.create_rpa_template(p_org_id,p_name,p_duoplus_template_id,p_variables,p_template_type)$$;
create function private.update_organization(p_org_id uuid,p_capacity integer,p_duoplus_interval_ms integer default null,p_telemetry_interval_ms integer default null) returns public.organizations language plpgsql security definer set search_path = '' as $$
declare v_org public.organizations;
begin
  perform private.require_admin(p_org_id);
  update public.organizations set capacity=p_capacity,duoplus_interval_ms=coalesce(p_duoplus_interval_ms,duoplus_interval_ms),telemetry_interval_ms=coalesce(p_telemetry_interval_ms,telemetry_interval_ms) where id=p_org_id returning * into v_org;
  return v_org;
end $$;
create function public.update_organization(p_org_id uuid,p_capacity integer,p_duoplus_interval_ms integer default null,p_telemetry_interval_ms integer default null) returns public.organizations language sql security invoker set search_path = '' as $$select private.update_organization(p_org_id,p_capacity,p_duoplus_interval_ms,p_telemetry_interval_ms)$$;


create function private.refresh_environment(p_org_id uuid,p_device_id uuid) returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_device public.devices; v_job public.jobs;
begin
  perform private.require_admin(p_org_id);
  select * into v_device from public.devices where id=p_device_id and org_id=p_org_id for update;
  if not found then raise exception 'Station not found' using errcode='P0002'; end if;
  update public.devices set environment_version=environment_version+1,environment_status='pending',last_error=null where id=p_device_id and org_id=p_org_id returning * into v_device;
  update public.jobs set payload=payload||jsonb_build_object('force_refresh',true) where org_id=p_org_id and device_id=p_device_id and kind='environment_sync' and status='pending' and payload->>'environment_version'=v_device.environment_version::text returning * into v_job;
  return v_job;
end $$;
create function public.refresh_environment(p_org_id uuid,p_device_id uuid) returns public.jobs language sql security invoker set search_path = '' as $$select private.refresh_environment(p_org_id,p_device_id)$$;
create function private.set_environment_refresh(p_org_id uuid,p_device_id uuid,p_enabled boolean) returns public.devices language plpgsql security definer set search_path = '' as $$
declare v_device public.devices;
begin
  perform private.require_admin(p_org_id);
  update public.devices set environment_refresh_enabled=p_enabled where id=p_device_id and org_id=p_org_id returning * into v_device;
  if not found then raise exception 'Station not found' using errcode='P0002'; end if;
  return v_device;
end $$;
create function public.set_environment_refresh(p_org_id uuid,p_device_id uuid,p_enabled boolean) returns public.devices language sql security invoker set search_path = '' as $$select private.set_environment_refresh(p_org_id,p_device_id,p_enabled)$$;
create function private.get_device_identity(p_org_id uuid,p_device_id uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select v.decrypted_secret::jsonb from private.device_identity_locks l join vault.decrypted_secrets v on v.id=l.vault_secret_id where l.org_id=p_org_id and l.device_id=p_device_id;
$$;
create function public.get_device_identity(p_org_id uuid,p_device_id uuid) returns jsonb language sql stable security invoker set search_path = '' as $$select private.get_device_identity(p_org_id,p_device_id)$$;
create function private.lock_device_identity(p_org_id uuid,p_device_id uuid,p_identity jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_secret_id uuid; v_baseline jsonb;
begin
  perform 1 from public.devices where id=p_device_id and org_id=p_org_id for update;
  if not found then raise exception 'Station not found' using errcode='P0002'; end if;
  select private.get_device_identity(p_org_id,p_device_id) into v_baseline;
  if v_baseline is not null then return v_baseline; end if;
  if p_identity is null or jsonb_typeof(p_identity)<>'object' or p_identity='{}'::jsonb or octet_length(p_identity::text)>60000 then raise exception 'Provider identity required' using errcode='22023'; end if;
  select vault.create_secret(p_identity::text,'station-identity:'||p_device_id::text,'Immutable provider-assigned identity baseline') into v_secret_id;
  insert into private.device_identity_locks(org_id,device_id,vault_secret_id) values(p_org_id,p_device_id,v_secret_id);
  update public.devices set identity_locked_at=now(),identity_status='locked',identity_changed_fields='{}' where org_id=p_org_id and id=p_device_id;
  return p_identity;
end $$;
create function public.lock_device_identity(p_org_id uuid,p_device_id uuid,p_identity jsonb) returns jsonb language sql security invoker set search_path = '' as $$select private.lock_device_identity(p_org_id,p_device_id,p_identity)$$;


-- Route arrival uses compare-and-swap so a stale worker cannot undo a user control.
create function private.complete_route(p_org_id uuid,p_device_id uuid,p_control_version integer,p_lat double precision,p_lng double precision,p_s2_cell_id text) returns public.devices language plpgsql security definer set search_path = '' as $$
declare v_device public.devices;
begin
  update public.devices set lat=p_lat,lng=p_lng,anchor_lat=p_lat,anchor_lng=p_lng,s2_cell_id=p_s2_cell_id,status='STATIONARY',route='[]'::jsonb,route_progress_meters=0,speed=0,environment_version=environment_version+1,control_version=control_version+1,environment_status='pending',environment_synced_at=null,ssid=null,bssid=null,mcc_mnc=null,signal_dbm=null
  where id=p_device_id and org_id=p_org_id and control_version=p_control_version and status='NAVIGATING' returning * into v_device;
  return v_device;
end $$;
create function public.complete_route(p_org_id uuid,p_device_id uuid,p_control_version integer,p_lat double precision,p_lng double precision,p_s2_cell_id text) returns public.devices language sql security invoker set search_path = '' as $$select private.complete_route(p_org_id,p_device_id,p_control_version,p_lat,p_lng,p_s2_cell_id)$$;


-- Deleting metadata, including cascades from a workspace/device deletion, cleans
-- up its encrypted Vault object. The identity baseline itself has no update API.
create function private.delete_vault_reference() returns trigger language plpgsql security definer set search_path = '' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end $$;
create trigger credential_secret_cleanup after delete on private.credential_secrets for each row execute function private.delete_vault_reference();
create trigger identity_secret_cleanup after delete on private.device_identity_locks for each row execute function private.delete_vault_reference();

-- Pin privileges explicitly; defaults differ among Supabase project generations.
revoke all on public.organizations,public.org_members,public.api_keys,public.devices,public.telemetry_ticks,public.rpa_templates,public.jobs,public.job_attempts,public.environment_snapshots from public,anon,authenticated;
grant select on public.organizations,public.org_members,public.api_keys,public.devices,public.telemetry_ticks,public.rpa_templates,public.jobs,public.job_attempts,public.environment_snapshots to authenticated;
grant select,insert,update,delete on public.organizations,public.org_members,public.api_keys,public.devices,public.telemetry_ticks,public.rpa_templates,public.jobs,public.job_attempts,public.environment_snapshots to service_role;
grant usage,select on sequence public.telemetry_ticks_id_seq to service_role;
revoke all on private.credential_secrets,private.device_identity_locks from public,anon,authenticated,service_role;
revoke all on all functions in schema private from public,anon,authenticated,service_role;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.create_organization(text),private.store_credential(uuid,text,text,text),private.delete_credential(uuid),private.register_station(uuid,text,text,double precision,double precision,text,text),private.control_station(uuid,uuid,text,double precision,double precision,jsonb,double precision,text),private.enqueue_job(uuid,text,uuid,jsonb),private.create_rpa_template(uuid,text,text,jsonb,integer),private.update_organization(uuid,integer,integer,integer) to authenticated;
grant execute on function private.complete_route(uuid,uuid,integer,double precision,double precision,text) to service_role;
grant execute on function private.get_credential(uuid,uuid),private.get_device_identity(uuid,uuid),private.lock_device_identity(uuid,uuid,jsonb) to service_role;
grant execute on function private.refresh_environment(uuid,uuid),private.set_environment_refresh(uuid,uuid,boolean) to authenticated;
revoke all on function public.create_organization(text),public.store_credential(uuid,text,text,text),public.delete_credential(uuid),public.get_credential(uuid,uuid),public.register_station(uuid,text,text,double precision,double precision,text,text),public.control_station(uuid,uuid,text,double precision,double precision,jsonb,double precision,text),public.enqueue_job(uuid,text,uuid,jsonb),public.create_rpa_template(uuid,text,text,jsonb,integer),public.update_organization(uuid,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.create_organization(text),public.store_credential(uuid,text,text,text),public.delete_credential(uuid),public.register_station(uuid,text,text,double precision,double precision,text,text),public.control_station(uuid,uuid,text,double precision,double precision,jsonb,double precision,text),public.enqueue_job(uuid,text,uuid,jsonb),public.create_rpa_template(uuid,text,text,jsonb,integer),public.update_organization(uuid,integer,integer,integer) to authenticated;
grant execute on function public.get_credential(uuid,uuid) to service_role;
revoke all on function public.refresh_environment(uuid,uuid),public.set_environment_refresh(uuid,uuid,boolean),public.get_device_identity(uuid,uuid),public.lock_device_identity(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.refresh_environment(uuid,uuid),public.set_environment_refresh(uuid,uuid,boolean) to authenticated;
grant execute on function public.get_device_identity(uuid,uuid),public.lock_device_identity(uuid,uuid,jsonb) to service_role;

revoke all on function public.complete_route(uuid,uuid,integer,double precision,double precision,text) from public,anon,authenticated,service_role;
grant execute on function public.complete_route(uuid,uuid,integer,double precision,double precision,text) to service_role;

-- Tenant-private broadcasts are receive-only for browsers. Workers publish with
-- the service key. Disable "Allow public access" in hosted Realtime settings.
create policy stations_telemetry_receive on realtime.messages for select to authenticated using (
  extension='broadcast' and exists(select 1 from public.org_members where user_id=(select auth.uid()) and 'org:'||org_id::text||':telemetry'=(select realtime.topic()))
);
-- Only control/status changes use Postgres Changes; ticks are broadcast + batched.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.devices,public.api_keys,public.jobs,public.organizations;
  end if;
end $$;
commit;
