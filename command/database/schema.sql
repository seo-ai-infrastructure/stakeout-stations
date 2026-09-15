-- Additive namespace: existing Stakeout tables and controllers are untouched.
create schema if not exists command_private;
revoke all on schema command_private from public,anon;
grant usage on schema command_private to authenticated,service_role;
create table public.cmd_workspaces (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null default 'My workspace',capacity integer not null default 3 check(capacity between 1 and 100),
 paused boolean not null default true,timezone text not null default 'America/New_York',provider_timezone text not null default 'UTC',
 connected boolean not null default false,sync_requested boolean not null default false,last_sync timestamptz,last_heartbeat timestamptz,last_error text,
 exclusive_control boolean not null default false,verified_capacity integer
);
create table command_private.credentials(workspace_id uuid primary key references public.cmd_workspaces(id) on delete cascade,secret_id uuid not null,key_hash text not null unique);
create table command_private.leases(workspace_id uuid primary key references public.cmd_workspaces(id) on delete cascade,owner uuid not null,expires_at timestamptz not null);
create table public.cmd_devices (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.cmd_workspaces(id) on delete cascade,
 external_id text not null,name text not null,client text not null default '',city text not null default '',latitude double precision check(latitude between -90 and 90),longitude double precision check(longitude between -180 and 180),timezone text not null default 'America/New_York',
 power text not null default 'unknown' check(power in ('off','on','starting','configuring','expired','unknown')),enabled boolean not null default false,last_seen timestamptz,expired_at timestamptz,
 unique(workspace_id,external_id),unique(workspace_id,id)
);
create table public.cmd_templates (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.cmd_workspaces(id) on delete cascade,
 external_id text not null,name text not null,description text not null default '',app text not null default 'Custom',template_type int not null default 2 check(template_type in (1,2)),
 parameters jsonb not null default '[]',variables_confirmed boolean not null default false,duration_minutes integer not null default 10 check(duration_minutes between 1 and 180),version integer not null default 1,
 unique(workspace_id,external_id,template_type),unique(workspace_id,id)
);
create table public.cmd_schedules (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.cmd_workspaces(id) on delete cascade,name text not null,
 device_ids uuid[] not null,template_ids uuid[] not null,frequency text not null check(frequency in ('daily','weekly','once')),days integer[] not null default '{1,2,3,4,5}',
 start_date date not null,end_date date,start_time text not null,end_time text not null,timezone text not null,variables jsonb not null default '{}',enabled boolean not null default true,priority integer not null default 1,
 unique(workspace_id,id),check(start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and start_time<end_time),check(end_date is null or end_date>=start_date)
);
create table public.cmd_jobs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.cmd_workspaces(id) on delete cascade,
 occurrence_key text not null,device_id uuid not null,template_id uuid not null,schedule_id uuid,
 status text not null default 'queued' check(status in ('queued','starting','submitting','running','stopping','attention','completed','failed','cancelled','missed')),
 due_at timestamptz not null,deadline_at timestamptz not null,started_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now(),position integer not null default 0,attempt integer not null default 1,
 error text,provider_name text not null,provider_records jsonb,template_snapshot jsonb not null,variables jsonb not null default '{}',outcome text check(outcome in ('completed','failed')),submission_at timestamptz,power_requested_at timestamptz,
 unique(workspace_id,occurrence_key),foreign key(workspace_id,device_id) references public.cmd_devices(workspace_id,id),foreign key(workspace_id,template_id) references public.cmd_templates(workspace_id,id),foreign key(workspace_id,schedule_id) references public.cmd_schedules(workspace_id,id)
);
create unique index cmd_one_active_job_per_device on public.cmd_jobs(device_id) where status in ('starting','submitting','running','stopping','attention');
create index cmd_jobs_dispatch on public.cmd_jobs(workspace_id,status,due_at,deadline_at);
create index cmd_jobs_schedule on public.cmd_jobs(workspace_id,schedule_id,device_id);
create index cmd_jobs_template on public.cmd_jobs(workspace_id,template_id);
create table public.cmd_events(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.cmd_workspaces(id) on delete cascade,message text not null,created_at timestamptz not null default now(),kind text not null default 'info');
create index cmd_events_recent on public.cmd_events(workspace_id,created_at desc);
alter table command_private.credentials enable row level security;
alter table command_private.leases enable row level security;
do $$ declare t text;begin foreach t in array array['cmd_workspaces','cmd_devices','cmd_templates','cmd_schedules','cmd_jobs','cmd_events'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = %I)',t,case when t='cmd_workspaces' then 'id' else 'workspace_id' end);
end loop;end $$;

create or replace function command_private.action(action text,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); r uuid; key_id uuid; dev uuid; temp uuid; p jsonb; w public.cmd_workspaces; s public.cmd_schedules;
begin
 if u is null then raise exception 'Sign in to continue';end if;
 insert into public.cmd_workspaces(id) values(u) on conflict do nothing;
 select * into w from public.cmd_workspaces where id=u for update;
 if action='bootstrap' then return to_jsonb(w);
 elsif action='settings' then
  if coalesce((payload->>'paused')::boolean,w.paused)=false and (not w.connected or not coalesce((payload->>'exclusive_control')::boolean,w.exclusive_control)) then raise exception 'Connect DuoPlus and confirm exclusive scheduling before resuming';end if;
  if payload ? 'timezone' and not exists(select 1 from pg_timezone_names where name=payload->>'timezone') then raise exception 'Invalid timezone';end if;
  if payload ? 'provider_timezone' and not exists(select 1 from pg_timezone_names where name=payload->>'provider_timezone') then raise exception 'Invalid provider timezone';end if;
  update public.cmd_workspaces set name=coalesce(nullif(payload->>'name',''),name),capacity=coalesce((payload->>'capacity')::integer,capacity),paused=coalesce((payload->>'paused')::boolean,paused),timezone=coalesce(payload->>'timezone',timezone),provider_timezone=coalesce(payload->>'provider_timezone',provider_timezone),exclusive_control=coalesce((payload->>'exclusive_control')::boolean,exclusive_control) where id=u;
 elsif action='connect' then
  if length(trim(payload->>'key'))<10 then raise exception 'Enter a valid DuoPlus API key';end if;
  select secret_id into key_id from command_private.credentials where workspace_id=u;
  if key_id is null then select vault.create_secret(payload->>'key','command-'||u::text) into key_id;
  else perform vault.update_secret(key_id,payload->>'key');end if;
  insert into command_private.credentials values(u,key_id,encode(extensions.digest(payload->>'key','sha256'),'hex')) on conflict(workspace_id) do update set key_hash=excluded.key_hash;
  update public.cmd_workspaces set connected=true,sync_requested=true,paused=true,last_error=null where id=u;
 elsif action='sync' then update public.cmd_workspaces set sync_requested=true where id=u;
 elsif action='device' then
  if not exists(select 1 from pg_timezone_names where name=payload->>'timezone') then raise exception 'Invalid timezone';end if;
  update public.cmd_devices set client=payload->>'client',city=payload->>'city',latitude=nullif(payload->>'latitude','')::float8,longitude=nullif(payload->>'longitude','')::float8,timezone=payload->>'timezone',enabled=(payload->>'enabled')::boolean where id=(payload->>'id')::uuid and workspace_id=u;
  if not found then raise exception 'Device not found';end if;
 elsif action='template' then
  if jsonb_typeof(payload->'parameters')<>'array' then raise exception 'Inputs must be an array';end if;
  for p in select value from jsonb_array_elements(payload->'parameters') loop
   if coalesce(p->>'key','') !~ '^[a-zA-Z_][a-zA-Z0-9_.-]*$' or coalesce(p->>'type','') not in ('string','number','boolean','textarea','file','excel') then raise exception 'Invalid template input';end if;
  end loop;
  if (select count(*) from jsonb_array_elements(payload->'parameters'))<>(select count(distinct value->>'key') from jsonb_array_elements(payload->'parameters')) then raise exception 'Input keys must be unique';end if;
  if nullif(payload->>'external_id','') is null or nullif(payload->>'name','') is null then raise exception 'Template ID and name are required';end if;
  r:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  insert into public.cmd_templates(id,workspace_id,external_id,name,description,app,template_type,parameters,variables_confirmed,duration_minutes)
   values(r,u,payload->>'external_id',payload->>'name',coalesce(payload->>'description',''),coalesce(payload->>'app','Custom'),coalesce((payload->>'template_type')::int,2),payload->'parameters',true,(payload->>'duration_minutes')::int)
   on conflict(id) do update set name=excluded.name,description=excluded.description,app=excluded.app,parameters=excluded.parameters,variables_confirmed=true,duration_minutes=excluded.duration_minutes,version=cmd_templates.version+1 where cmd_templates.workspace_id=u;
  if not found then raise exception 'Template not found';end if;
 elsif action='schedule' then
  if not exists(select 1 from pg_timezone_names where name=payload->>'timezone') then raise exception 'Invalid timezone';end if;
  if jsonb_array_length(payload->'device_ids')<1 or jsonb_array_length(payload->'template_ids')<1 then raise exception 'Choose devices and templates';end if;
  for dev in select value::uuid from jsonb_array_elements_text(payload->'device_ids') loop if not exists(select 1 from public.cmd_devices where id=dev and workspace_id=u and enabled and power<>'expired') then raise exception 'Device unavailable';end if;end loop;
  for temp in select value::uuid from jsonb_array_elements_text(payload->'template_ids') loop
   if not exists(select 1 from public.cmd_templates where id=temp and workspace_id=u and variables_confirmed) then raise exception 'Review template inputs first';end if;
   for p in select value from public.cmd_templates t,jsonb_array_elements(t.parameters) where t.id=temp loop
    if coalesce((p->>'required')::bool,false) and coalesce(nullif(payload->'variables'->>(p->>'key'),''),nullif(p->>'defaultValue','')) is null then raise exception 'Missing required template input: %',p->>'key';end if;
   end loop;
  end loop;
  r:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  insert into public.cmd_schedules(id,workspace_id,name,device_ids,template_ids,frequency,days,start_date,end_date,start_time,end_time,timezone,variables,enabled,priority)
   values(r,u,payload->>'name',array(select value::uuid from jsonb_array_elements_text(payload->'device_ids')),array(select value::uuid from jsonb_array_elements_text(payload->'template_ids')),payload->>'frequency',array(select value::int from jsonb_array_elements_text(payload->'days')),(payload->>'start_date')::date,nullif(payload->>'end_date','')::date,payload->>'start_time',payload->>'end_time',payload->>'timezone',payload->'variables',true,coalesce((payload->>'priority')::int,1))
   on conflict(id) do update set name=excluded.name,device_ids=excluded.device_ids,template_ids=excluded.template_ids,frequency=excluded.frequency,days=excluded.days,start_date=excluded.start_date,end_date=excluded.end_date,start_time=excluded.start_time,end_time=excluded.end_time,timezone=excluded.timezone,variables=excluded.variables,priority=excluded.priority where cmd_schedules.workspace_id=u;
  if not found then raise exception 'Schedule not found';end if;
 elsif action='toggle_schedule' then
  update public.cmd_schedules set enabled=(payload->>'enabled')::bool where id=(payload->>'id')::uuid and workspace_id=u;
  if not found then raise exception 'Schedule not found';end if;
  if not (payload->>'enabled')::bool then update public.cmd_jobs set status='cancelled',finished_at=now(),error='Schedule paused' where schedule_id=(payload->>'id')::uuid and workspace_id=u and status='queued';end if;
 elsif action='cancel_job' then
  update public.cmd_jobs set status='cancelled',finished_at=now() where id=(payload->>'id')::uuid and workspace_id=u and status='queued';
  if not found then raise exception 'Only queued tasks can be cancelled here';end if;
 elsif action='retry_job' then
  -- Only a confirmed terminal provider failure can be retried automatically by an operator.
  insert into public.cmd_jobs(workspace_id,occurrence_key,device_id,template_id,schedule_id,due_at,deadline_at,position,attempt,provider_name,template_snapshot,variables)
   select u,'retry:'||gen_random_uuid(),j.device_id,j.template_id,null,now(),now()+interval '12 hours',0,j.attempt+1,'cmd-'||gen_random_uuid(),j.template_snapshot,j.variables from public.cmd_jobs j join public.cmd_devices d on d.id=j.device_id where j.id=(payload->>'id')::uuid and j.workspace_id=u and j.status='failed' and d.power='off';
  if not found then raise exception 'Retry requires a confirmed failed task and a powered-off device';end if;
 else raise exception 'Unknown action';end if;
 return jsonb_build_object('ok',true,'id',r);
end $$;
revoke all on function command_private.action(text,jsonb) from public,anon;
grant execute on function command_private.action(text,jsonb) to authenticated;
create function public.cmd_action(action text,payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$ select command_private.action(action,payload); $$;
revoke all on function public.cmd_action(text,jsonb) from public,anon;grant execute on function public.cmd_action(text,jsonb) to authenticated;

create function public.cmd_worker_key(target uuid) returns text language sql security definer set search_path='' as $$select s.decrypted_secret from command_private.credentials c join vault.decrypted_secrets s on s.id=c.secret_id where c.workspace_id=target;$$;
revoke all on function public.cmd_worker_key(uuid) from public,anon,authenticated;grant execute on function public.cmd_worker_key(uuid) to service_role;
create function public.cmd_worker_lease(target uuid,worker uuid) returns boolean language plpgsql security definer set search_path='' as $$begin
 insert into command_private.leases values(target,worker,now()+interval '120 seconds') on conflict(workspace_id) do update set owner=excluded.owner,expires_at=excluded.expires_at where command_private.leases.expires_at<now() or command_private.leases.owner=worker;
 return found;end $$;
revoke all on function public.cmd_worker_lease(uuid,uuid) from public,anon,authenticated;grant execute on function public.cmd_worker_lease(uuid,uuid) to service_role;
create function public.cmd_claim(target uuid,worker uuid) returns setof public.cmd_jobs language plpgsql security definer set search_path='' as $$
declare w public.cmd_workspaces;selected public.cmd_jobs;n integer;
begin
 select * into w from public.cmd_workspaces where id=target for update;
 if not exists(select 1 from command_private.leases where workspace_id=target and owner=worker and expires_at>now()+interval '30 seconds') then return;end if;
 if w.paused or not w.exclusive_control or w.last_sync is null or w.last_sync<now()-interval '90 seconds' or w.verified_capacity is null then return;end if;
 if exists(select 1 from public.cmd_devices where workspace_id=target and power='unknown') then return;end if;
 select count(*) into n from (select id from public.cmd_devices where workspace_id=target and power not in ('off','expired') union select device_id from public.cmd_jobs where workspace_id=target and status in ('starting','submitting','running','stopping','attention')) occupied;
 if n>=least(w.capacity,w.verified_capacity) then return;end if;
 select j.* into selected from public.cmd_jobs j join public.cmd_devices d on d.id=j.device_id left join public.cmd_schedules s on s.id=j.schedule_id
 where j.workspace_id=target and j.status='queued' and j.due_at<=now() and j.deadline_at>now() and d.enabled and d.power='off' and (j.schedule_id is null or s.enabled)
 and not exists(select 1 from public.cmd_jobs a where a.device_id=j.device_id and a.status in ('starting','submitting','running','stopping','attention'))
 and not exists(select 1 from public.cmd_jobs p where p.schedule_id=j.schedule_id and p.device_id=j.device_id and p.due_at=j.due_at and p.position<j.position and p.status not in ('completed','failed','cancelled','missed'))
 order by j.deadline_at,coalesce(s.priority,1) desc,j.position,j.created_at limit 1 for update of j skip locked;
 if selected.id is null then return;end if;
 return query update public.cmd_jobs set status='starting',started_at=now() where id=selected.id returning *;
end $$;
revoke all on function public.cmd_claim(uuid,uuid) from public,anon,authenticated;grant execute on function public.cmd_claim(uuid,uuid) to service_role;
