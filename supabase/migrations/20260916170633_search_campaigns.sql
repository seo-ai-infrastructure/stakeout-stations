begin;
create table public.search_campaigns (
 id uuid primary key,
 org_id uuid not null references public.organizations(id),
 created_by uuid not null references auth.users(id),
 configuration jsonb not null check(jsonb_typeof(configuration)='object'),
 status text not null default 'draft' check(status in ('draft')),
 created_at timestamptz not null default now(),
 check (configuration ?& array['business','listing','location','keywords','days','warmup','devices','concurrency','surfaces']),
 check ((configuration->>'days')::integer between 11 and 45),
 check ((configuration->>'warmup')::integer between 10 and 30 and (configuration->>'warmup')::integer < (configuration->>'days')::integer),
 check ((configuration->>'devices')::integer between 1 and 100),
 check ((configuration->>'concurrency')::integer between 1 and (configuration->>'devices')::integer),
 check (jsonb_typeof(configuration->'surfaces')='array' and jsonb_array_length(configuration->'surfaces') between 1 and 8),
 check (jsonb_typeof(configuration->'business')='string' and length(configuration->>'business') between 1 and 160),
 check (jsonb_typeof(configuration->'keywords')='array' and jsonb_array_length(configuration->'keywords') between 1 and 100),
 unique(org_id,id)
);
create index search_campaigns_org_created on public.search_campaigns(org_id,created_at desc);
alter table public.search_campaigns enable row level security;
revoke all on public.search_campaigns from anon,authenticated;
grant select,insert on public.search_campaigns to authenticated;
grant all on public.search_campaigns to service_role;
create policy search_campaigns_read on public.search_campaigns for select to authenticated using (private.is_member(org_id));
create policy search_campaigns_create on public.search_campaigns for insert to authenticated with check (
 created_by=(select auth.uid()) and status='draft' and exists(select 1 from public.org_members m where m.org_id=search_campaigns.org_id and m.user_id=(select auth.uid()) and m.role in ('owner','admin'))
);
commit;
