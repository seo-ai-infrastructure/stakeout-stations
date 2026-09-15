-- Automatic provider capacity; daily task lists run until complete.
alter table public.cmd_workspaces drop constraint cmd_workspaces_capacity_check;
alter table public.cmd_workspaces add constraint cmd_workspaces_capacity_check check(capacity>=0);
alter table public.cmd_workspaces alter column capacity set default 0;
update public.cmd_workspaces set capacity=coalesce(verified_capacity,0);
do $$ declare r record;begin
 for r in select conname from pg_constraint where conrelid='public.cmd_schedules'::regclass and contype='c' and pg_get_constraintdef(oid) like '%start_time%' loop
 execute format('alter table public.cmd_schedules drop constraint %I',r.conname);
 end loop;
end $$;
alter table public.cmd_schedules add constraint cmd_valid_start_time check(start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
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
  update public.cmd_workspaces set name=coalesce(nullif(payload->>'name',''),name),capacity=coalesce(verified_capacity,capacity),paused=coalesce((payload->>'paused')::boolean,paused),timezone=coalesce(payload->>'timezone',timezone),provider_timezone=coalesce(payload->>'provider_timezone',provider_timezone),exclusive_control=coalesce((payload->>'exclusive_control')::boolean,exclusive_control) where id=u;
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
create or replace function public.cmd_claim(target uuid,worker uuid) returns setof public.cmd_jobs language plpgsql security definer set search_path='' as $$
declare w public.cmd_workspaces;selected public.cmd_jobs;n integer;
begin
 select * into w from public.cmd_workspaces where id=target for update;
 if not exists(select 1 from command_private.leases where workspace_id=target and owner=worker and expires_at>now()+interval '30 seconds') then return;end if;
 if w.paused or not w.exclusive_control or w.last_sync is null or w.last_sync<now()-interval '90 seconds' or w.verified_capacity is null then return;end if;
 if exists(select 1 from public.cmd_devices where workspace_id=target and power='unknown') then return;end if;
 select count(*) into n from (select id from public.cmd_devices where workspace_id=target and power not in ('off','expired') union select device_id from public.cmd_jobs where workspace_id=target and status in ('starting','submitting','running','stopping','attention')) occupied;
 if n>=w.verified_capacity then return;end if;
 select j.* into selected from public.cmd_jobs j join public.cmd_devices d on d.id=j.device_id left join public.cmd_schedules s on s.id=j.schedule_id
 where j.workspace_id=target and j.status='queued' and j.due_at<=now() and d.enabled and d.power='off' and (j.schedule_id is null or s.enabled)
 and not exists(select 1 from public.cmd_jobs a where a.device_id=j.device_id and a.status in ('starting','submitting','running','stopping','attention'))
 and not exists(select 1 from public.cmd_jobs p where p.schedule_id=j.schedule_id and p.device_id=j.device_id and p.due_at=j.due_at and p.position<j.position and p.status not in ('completed','failed','cancelled','missed'))
 order by j.deadline_at,coalesce(s.priority,1) desc,j.position,j.created_at limit 1 for update of j skip locked;
 if selected.id is null then return;end if;
 return query update public.cmd_jobs set status='starting',started_at=now() where id=selected.id returning *;
end $$;
revoke all on function public.cmd_claim(uuid,uuid) from public,anon,authenticated;grant execute on function public.cmd_claim(uuid,uuid) to service_role;
-- Move the reservation to the next task on the same powered phone atomically.
create or replace function public.cmd_continue(target uuid,worker uuid,finished uuid)
returns setof public.cmd_jobs language plpgsql security definer set search_path='' as $$
declare w public.cmd_workspaces;previous public.cmd_jobs;next_job public.cmd_jobs;n int;
begin
 select * into w from public.cmd_workspaces where id=target for update;
 if not exists(select 1 from command_private.leases where workspace_id=target and owner=worker and expires_at>now()+interval '30 seconds') then return;end if;
 if w.paused or not w.exclusive_control or w.verified_capacity is null or w.last_sync is null or w.last_sync<now()-interval '90 seconds' then return;end if;
 select * into previous from public.cmd_jobs where id=finished and workspace_id=target and status='stopping' and outcome is not null for update;
 if previous.id is null then return;end if;
 if not exists(select 1 from public.cmd_devices where id=previous.device_id and enabled and power='on' and last_seen>now()-interval '30 seconds') then return;end if;
 select count(*) into n from (select id from public.cmd_devices where workspace_id=target and power not in ('off','expired') union select device_id from public.cmd_jobs where workspace_id=target and status in ('starting','submitting','running','stopping','attention')) occupied;
 if n>w.verified_capacity then return;end if;
 select j.* into next_job from public.cmd_jobs j left join public.cmd_schedules s on s.id=j.schedule_id
 where j.workspace_id=target and j.device_id=previous.device_id and j.status='queued' and j.due_at<=now() and (j.schedule_id is null or s.enabled)
 and not exists(select 1 from public.cmd_jobs p where p.id<>previous.id and p.schedule_id=j.schedule_id and p.device_id=j.device_id and p.due_at=j.due_at and p.position<j.position and p.status not in ('completed','failed','cancelled','missed'))
 order by j.due_at,j.position,j.created_at limit 1 for update of j skip locked;
 if next_job.id is null then return;end if;
 update public.cmd_jobs set status=previous.outcome,finished_at=now() where id=previous.id;
 return query update public.cmd_jobs set status='starting',started_at=now(),power_requested_at=now() where id=next_job.id returning *;
end $$;
revoke all on function public.cmd_continue(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cmd_continue(uuid,uuid,uuid) to service_role;

