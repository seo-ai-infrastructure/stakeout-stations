begin;
create table public.search_billing (
 org_id uuid primary key references public.organizations(id), customer_id text unique, subscription_id text unique,
 status text not null default 'inactive', price_id text, device_limit integer not null default 0 check(device_limit>=0),
 parallel_limit integer not null default 0 check(parallel_limit>=0), valid_until timestamptz, updated_at timestamptz not null default now()
);
create table private.search_billing_events(id text primary key,created_at timestamptz not null default now());
create table private.search_billing_locks(org_id uuid primary key references public.organizations(id),token uuid not null,expires_at timestamptz not null);
create table public.search_managed_devices (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),provider_id text not null unique,
 name text not null,power text not null default 'unknown',observed_at timestamptz,enabled boolean not null default false,unique(org_id,id)
);
create table public.search_templates (id text primary key,name text not null,template_type integer not null check(template_type in (1,2)),variable_schema jsonb not null default '{}',capture_enabled boolean not null default false,enabled boolean not null default false);
alter table public.search_templates enable row level security;
revoke all on public.search_templates from anon,authenticated;
grant select on public.search_templates to authenticated;grant all on public.search_templates to service_role;
create policy approved_templates on public.search_templates for select to authenticated using(enabled);
create table public.search_routines (
 id uuid primary key,org_id uuid not null,campaign_id uuid not null,device_id uuid not null,
 name text not null check(length(name) between 1 and 120),template_id text not null,template_type integer not null check(template_type in (1,2)),
 variables jsonb not null default '{}',surface text not null,keyword text not null default '',
 enabled boolean not null default true,created_at timestamptz not null default now(),
 foreign key(org_id,campaign_id) references public.search_campaigns(org_id,id),
 foreign key(org_id,device_id) references public.search_managed_devices(org_id,id),unique(org_id,id)
);
create table public.search_runs (
 id uuid primary key default gen_random_uuid(),org_id uuid not null,routine_id uuid not null,device_id uuid not null,
 due_at timestamptz not null,status text not null default 'queued' check(status in ('queued','booting','submitting','submitted','running','stopping','completed','failed','attention')),
 provider_task_id text,provider_name text not null unique default ('stakeout-'||gen_random_uuid()::text),
 provider_outcome text,started_at timestamptz,finished_at timestamptz,last_error text,created_at timestamptz not null default now(),
 foreign key(org_id,routine_id) references public.search_routines(org_id,id),foreign key(org_id,device_id) references public.search_managed_devices(org_id,id),
 unique(routine_id,due_at),unique(org_id,id)
);
create index search_runs_due on public.search_runs(status,due_at);
create unique index search_runs_one_device on public.search_runs(device_id) where status in ('booting','submitting','submitted','running','stopping','attention');
create table public.search_captures (
 id uuid primary key,org_id uuid not null,run_id uuid not null,stage text not null check(length(stage) between 1 and 80),
 status text not null default 'uploading' check(status in ('uploading','ready','rejected')),
 observed_at timestamptz not null,context jsonb not null,artifacts jsonb not null,visible_text jsonb,created_at timestamptz not null default now(),
 foreign key(org_id,run_id) references public.search_runs(org_id,id)
);
create index search_captures_run on public.search_captures(org_id,run_id,created_at);
create table private.search_pool (
 id boolean primary key default true check(id),capacity integer not null default 0 check(capacity between 0 and 1000),
 external_on integer not null default 0,observed_at timestamptz,leader uuid,lease_until timestamptz,api_after timestamptz
);
insert into private.search_pool(id) values(true);
-- No customer can change billing, device assignment, run state, or evidence provenance.
do $$declare t text;begin foreach t in array array['search_billing','search_managed_devices','search_routines','search_runs','search_captures'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy tenant_read on public.%I for select to authenticated using (private.is_member(org_id))',t);
end loop;end$$;
revoke all on private.search_pool,private.search_billing_events,private.search_billing_locks from public,anon,authenticated;
grant all on private.search_pool,private.search_billing_events,private.search_billing_locks to service_role;
alter table private.search_pool enable row level security;
alter table private.search_billing_events enable row level security;
alter table private.search_billing_locks enable row level security;
create function public.search_billing_lock(p_org uuid,p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$begin
 insert into private.search_billing_locks values(p_org,p_token,now()+interval '120 seconds') on conflict(org_id) do update set token=excluded.token,expires_at=excluded.expires_at where private.search_billing_locks.expires_at<now() or private.search_billing_locks.token=p_token;
 return exists(select 1 from private.search_billing_locks where org_id=p_org and token=p_token and expires_at>now());end$$;
create function public.search_billing_unlock(p_org uuid,p_token uuid) returns void language sql security invoker set search_path='' as $$delete from private.search_billing_locks where org_id=p_org and token=p_token$$;
create function public.search_billing_apply(p_org uuid,p_token uuid,p_event text,p_subscription text,p_status text,p_price text,p_devices integer,p_parallel integer,p_until timestamptz) returns void language plpgsql security invoker set search_path='' as $$begin
 perform 1 from private.search_billing_locks where org_id=p_org and token=p_token and expires_at>now() for update;if not found then raise exception 'Billing lease expired';end if;
 if not exists(select 1 from private.search_billing_events where id=p_event) then
 update public.search_billing set subscription_id=p_subscription,status=p_status,price_id=p_price,device_limit=p_devices,parallel_limit=p_parallel,valid_until=p_until,updated_at=now() where org_id=p_org;
 insert into private.search_billing_events(id) values(p_event);
 end if;delete from private.search_billing_locks where org_id=p_org and token=p_token;end$$;
create function public.search_schedule(p_org uuid,p_campaign uuid,p_device uuid,p_id uuid,p_name text,p_template text,p_type integer,p_vars jsonb,p_surface text,p_keyword text,p_start timestamptz,p_count integer,p_interval integer) returns uuid language plpgsql security invoker set search_path='' as $$declare b public.search_billing;c public.search_campaigns;begin
 select * into b from public.search_billing where org_id=p_org for update;
 if not found then raise exception 'Active subscription required';end if;
 if b.status not in ('active','trialing') or b.valid_until<=now() or b.valid_until is null then raise exception 'Active subscription required';end if;
 select * into c from public.search_campaigns where org_id=p_org and id=p_campaign;
 if not found then raise exception 'Campaign unavailable';end if;
 if (c.configuration->>'devices')::int>b.device_limit or (c.configuration->>'concurrency')::int>b.parallel_limit then raise exception 'Plan allowance exceeded';end if;
 if not exists(select 1 from public.search_managed_devices where id=p_device and org_id=p_org and enabled) then raise exception 'Device not assigned';end if;
 if (select count(*) from public.search_managed_devices where org_id=p_org and enabled)>b.device_limit then raise exception 'Assigned devices exceed plan';end if;
 if not exists(select 1 from public.search_templates where id=p_template and template_type=p_type and enabled) then raise exception 'Template not approved';end if;
 if p_count not between 1 and 45 or p_interval not between 1 and 30 or (p_count-1)*p_interval>=(c.configuration->>'days')::int or p_start<now()-interval '1 minute' or p_start>now()+interval '90 days' then raise exception 'Invalid schedule window';end if;
 if exists(select 1 from public.search_routines where id=p_id and org_id=p_org) then return p_id;end if;
 if (select count(*) from public.search_runs where org_id=p_org and status='queued')+p_count>10000 then raise exception 'Queue limit reached';end if;
 insert into public.search_routines(id,org_id,campaign_id,device_id,name,template_id,template_type,variables,surface,keyword) values(p_id,p_org,p_campaign,p_device,p_name,p_template,p_type,p_vars,p_surface,p_keyword);
 insert into public.search_runs(org_id,routine_id,device_id,due_at) select p_org,p_id,p_device,p_start+make_interval(days=>i*p_interval) from generate_series(0,p_count-1) i;
 return p_id;end$$;
create function public.search_worker_leader(p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$begin
 update private.search_pool set leader=p_token,lease_until=now()+interval '90 seconds' where id and (leader=p_token or lease_until<now() or lease_until is null);
 return found;end$$;
create function public.search_worker_inventory(p_token uuid,p_external integer,p_capacity integer,p_power jsonb) returns void language plpgsql security invoker set search_path='' as $$begin
 update private.search_pool set external_on=greatest(0,p_external),capacity=greatest(0,least(1000,p_capacity)),observed_at=now() where id and leader=p_token and lease_until>now();if not found then raise exception 'Worker lease lost';end if;
 update public.search_managed_devices set power=coalesce(p_power->>provider_id,'unknown'),observed_at=now();end$$;
create function public.search_api_gate(p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$begin
 update private.search_pool set api_after=now()+interval '1250 milliseconds' where id and leader=p_token and lease_until>now() and (api_after is null or api_after<=now());return found;end$$;
create function public.search_claim(p_token uuid) returns setof public.search_runs language plpgsql security invoker set search_path='' as $$declare p private.search_pool;j public.search_runs;begin
 select * into p from private.search_pool where id for update;
 if p.leader is distinct from p_token or p.lease_until<=now() or p.observed_at<now()-interval '30 seconds' or p.observed_at is null then return;end if;
 if p.capacity<=p.external_on+(select count(*) from public.search_runs where status in ('booting','submitting','submitted','running','stopping','attention')) then return;end if;
 select r.* into j from public.search_runs r join public.search_routines s on s.id=r.routine_id join public.search_campaigns c on c.id=s.campaign_id join public.search_billing b on b.org_id=r.org_id join public.search_managed_devices d on d.id=r.device_id
 where r.status='queued' and r.due_at<=now() and s.enabled and d.enabled and d.power='off' and d.observed_at>now()-interval '30 seconds' and b.status in ('active','trialing') and b.valid_until>now()
 and not exists(select 1 from public.search_runs x where x.device_id=r.device_id and x.status in ('booting','submitting','submitted','running','stopping','attention'))
 and b.parallel_limit>(select count(*) from public.search_runs x where x.org_id=r.org_id and x.status in ('booting','submitting','submitted','running','stopping','attention'))
 and (c.configuration->>'concurrency')::int>(select count(*) from public.search_runs x join public.search_routines xr on xr.id=x.routine_id where xr.campaign_id=s.campaign_id and x.status in ('booting','submitting','submitted','running','stopping','attention'))
 order by r.due_at,r.id for update of r skip locked limit 1;
 if not found then return;end if;
 update public.search_runs set status='booting',started_at=now() where id=j.id returning * into j;return next j;end$$;
create function public.search_run_update(p_token uuid,p_id uuid,p_expected text,p_status text,p_task text default null,p_outcome text default null,p_error text default null) returns boolean language plpgsql security invoker set search_path='' as $$begin
 perform 1 from private.search_pool where id and leader=p_token and lease_until>now() for update;if not found then return false;end if;
 update public.search_runs set status=p_status,provider_task_id=coalesce(p_task,provider_task_id),provider_outcome=coalesce(p_outcome,provider_outcome),last_error=p_error,finished_at=case when p_status in ('completed','failed') then now() else finished_at end where id=p_id and status=p_expected;return found;end$$;
-- Worker-only RPCs never grant public EXECUTE.
do $$declare f record;begin for f in select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('search_billing_lock','search_billing_unlock','search_billing_apply','search_schedule','search_worker_leader','search_worker_inventory','search_api_gate','search_claim','search_run_update') loop
 execute 'revoke all on function '||f.signature||' from public,anon,authenticated';execute 'grant execute on function '||f.signature||' to service_role';end loop;end$$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('search-evidence','search-evidence',false,268435456,array['application/xml','text/xml','image/png','image/jpeg','video/mp4']) on conflict(id) do nothing;
commit;
