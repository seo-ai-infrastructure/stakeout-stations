-- Run against a dedicated staging/new project as postgres. All fixtures roll back.
begin;
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  org_a uuid; org_b uuid; device_a uuid; key_a uuid;
  secret_id uuid; decrypted text; encrypted text;
begin
  insert into auth.users(id,is_anonymous) values(user_a,false),(user_b,false);
  perform set_config('request.jwt.claim.sub',user_a::text,true);
  execute 'set local role authenticated';
  select (public.create_organization('Hosted smoke A')).id into org_a;
  select (public.register_station(org_a,'SMOKE-A','test-phone',28,-82,'SIMULATION','88dd')).id into device_a;
  select public.store_credential(org_a,'duoplus','canary','hosted-smoke-only') into key_a;
  if (select count(*) from public.jobs where device_id=device_a and kind='environment_sync') <> 1 then
    raise exception 'Provisioning outbox failed';
  end if;
  if has_schema_privilege(current_user,'vault','USAGE') or has_function_privilege(current_user,'public.get_credential(uuid,uuid)','EXECUTE') then
    raise exception 'Browser secret access exposed';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',user_b::text,true);
  execute 'set local role authenticated';
  select (public.create_organization('Hosted smoke B')).id into org_b;
  if exists(select 1 from public.devices where id=device_a) or exists(select 1 from public.api_keys where id=key_a) then
    raise exception 'Cross-tenant read exposed';
  end if;
  begin
    perform public.control_station(org_a,device_a,'pause');
    raise exception 'Cross-tenant mutation allowed';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  select vault_secret_id into secret_id from private.credential_secrets where key_id=key_a;
  select secret into encrypted from vault.secrets where id=secret_id;
  select decrypted_secret into decrypted from vault.decrypted_secrets where id=secret_id;
  if decrypted is distinct from 'hosted-smoke-only' or encrypted is null or encrypted='hosted-smoke-only' then
    raise exception 'Hosted Vault encryption round trip failed';
  end if;
  execute 'set local role service_role';
  if public.get_credential(org_a,key_a) is distinct from 'hosted-smoke-only' or public.get_credential(org_b,key_a) is not null then
    raise exception 'Worker credential tenant binding failed';
  end if;
  execute 'reset role';
end $$;
rollback;
select 'passed: tenant RLS, mutation authorization, provisioning outbox, hosted Vault encryption, worker tenant binding; fixtures rolled back' as result;
