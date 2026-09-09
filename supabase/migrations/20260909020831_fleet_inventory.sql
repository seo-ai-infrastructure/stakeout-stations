-- Metadata-only snapshots. Only the Railway worker writes these rows.
create table public.fleet_inventory (
  key_id uuid primary key,
  org_id uuid not null,
  devices jsonb not null default '[]'::jsonb check (jsonb_typeof(devices) = 'array'),
  synced_at timestamptz,
  checked_at timestamptz not null default now(),
  status text not null default 'syncing' check (status in ('syncing','ready','error')),
  last_error text,
  foreign key (org_id,key_id) references public.api_keys(org_id,id) on delete cascade
);
create index fleet_inventory_org_idx on public.fleet_inventory(org_id);
alter table public.fleet_inventory enable row level security;
revoke all on public.fleet_inventory from public,anon,authenticated;
grant select on public.fleet_inventory to authenticated;
grant select,insert,update,delete on public.fleet_inventory to service_role;
create policy fleet_inventory_member_read on public.fleet_inventory for select to authenticated using (private.is_member(org_id));
create trigger fleet_inventory_immutable_org before update on public.fleet_inventory for each row execute function private.immutable_org_id();
