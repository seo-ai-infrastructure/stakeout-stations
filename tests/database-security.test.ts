import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// PGlite exercises PostgreSQL RLS, RPC authorization and transactions. Vault is
// intentionally mocked ONLY here: encryption and hosted Realtime require live QA.
const fixtures = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, is_anonymous boolean default false);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text not null,name text unique,description text);
create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(p_secret text,p_name text default null,p_description text default null) returns uuid language plpgsql as $$declare v_id uuid; begin insert into vault.secrets(secret,name,description) values(p_secret,p_name,p_description) returning id into v_id; return v_id; end$$;
create schema realtime;
create table realtime.messages(id bigint,extension text,topic text);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
grant usage on schema realtime to authenticated;
grant select on realtime.messages to authenticated;
grant execute on function realtime.topic() to authenticated;
`;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void test('PostgreSQL tenant isolation, credential confinement, and durable controls', async (t) => {
  const db = new PGlite();
  const files = (await readdir('supabase/migrations')).filter((file) => file.endsWith('.sql')).sort();
  await db.exec(fixtures);
  for (const file of files) {
    const migration = (await readFile(`supabase/migrations/${file}`, 'utf8')).replace(/^create extension if not exists supabase_vault with schema vault;$/m, '-- Vault mocked by test fixture.');
    await db.exec(migration);
  }
  await db.query('insert into auth.users(id) values($1),($2),($3)', [A,B,C]);
  async function asUser(user: string) {
    await db.exec('reset role; set role authenticated;');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  }
  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await db.query<{ result: T }>(sql, params); return result.rows[0]!.result;
  }
  let orgA = '', orgB = '', deviceA = '', deviceB = '', keyA = '';
  await t.test('all public application tables and private secrets enable RLS', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'");
    assert.equal(rows.rows.length, 12);
    assert.ok(rows.rows.every((row) => row.relrowsecurity), JSON.stringify(rows.rows));
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='api_keys'");
    assert.ok(columns.rows.every((row) => !/secret|encrypted|vault/.test(row.column_name)));
  });
  await t.test('authenticated onboarding creates an owner atomically; registration creates the outbox job', async () => {
    await asUser(A);
    orgA = await scalar<string>("select (public.create_organization('Alpha')).id as result");
    deviceA = await scalar<string>("select (public.register_station($1,'A-STATION','phone-a',28,-82,'SIMULATION','88dd')).id as result", [orgA]);
    const jobs = await db.query<{ payload: Record<string, unknown> }>("select payload from public.jobs where org_id=$1 and device_id=$2", [orgA,deviceA]);
    assert.equal(jobs.rows.length, 1);
    assert.deepEqual(jobs.rows[0]!.payload, { environment_version: 1, target_lat: 28, target_lng: -82 });
    await asUser(B);
    orgB = await scalar<string>("select (public.create_organization('Bravo')).id as result");
    deviceB = await scalar<string>("select (public.register_station($1,'B-STATION','phone-b',30,-81,'SIMULATION','88ff')).id as result", [orgB]);
  });
  await t.test('RLS hides every other tenant and RPCs reject other-tenant device IDs', async () => {
    await asUser(B);
    for (const table of ['organizations','devices','jobs']) {
      const result = await db.query(`select * from public.${table} where ${table==='organizations'?'id':'org_id'}=$1`, [orgA]);
      assert.equal(result.rows.length, 0, table);
    }
    await assert.rejects(db.query("select public.control_station($1,$2,'pause')", [orgB,deviceA]), /Station not found/);
    await assert.rejects(db.query("select public.control_station($1,$2,'pause')", [orgA,deviceA]), /administrator required/);
  });
  await t.test('members cannot self-escalate or mutate through direct table writes', async () => {
    await db.exec('reset role;');
    await db.query("insert into public.org_members(org_id,user_id,role) values($1,$2,'member')", [orgA,C]);
    await asUser(C);
    await assert.rejects(db.query("update public.org_members set role='owner' where user_id=$1", [C]), /permission denied/);
    await assert.rejects(db.query("select public.store_credential($1,'duoplus','stolen','secret')", [orgA]), /administrator required/);
    await assert.rejects(db.query("update public.devices set org_id=$1 where id=$2", [orgB,deviceA]), /permission denied/);
  });
  await t.test('browser can store credential but cannot read Vault or decrypt via RPC', async () => {
    await asUser(A);
    keyA = await scalar<string>("select public.store_credential($1,'duoplus','main','test-only-secret') as result", [orgA]);
    await assert.rejects(db.query('select public.get_credential($1,$2)', [orgA,keyA]), /permission denied/);
    await assert.rejects(db.query('select * from private.credential_secrets'), /permission denied/);
    await assert.rejects(db.query('select * from vault.decrypted_secrets'), /permission denied/);
    await asUser(B);
    await assert.rejects(db.query('select public.delete_credential($1)', [keyA]), /administrator required/);
  });
  await t.test('service decryptor binds the requested key and tenant', async () => {
    await db.exec('reset role; set role service_role;');
    assert.equal(await scalar("select public.get_credential($1,$2) as result",[orgA,keyA]),'test-only-secret');
    assert.equal(await scalar("select public.get_credential($1,$2) as result",[orgB,keyA]),null);
  });
  await t.test('composite tenant FKs and immutable org IDs constrain the service worker too', async () => {
    await assert.rejects(db.query("insert into public.telemetry_ticks(event_id,org_id,device_id,lat,lng,accuracy_meters,provider,source) values(gen_random_uuid(),$1,$2,28,-82,15,'test','simulated')", [orgB,deviceA]), /foreign key constraint/);
    await assert.rejects(db.query("update public.devices set org_id=$1 where id=$2", [orgB,deviceA]), /Tenant identity is immutable/);
  });
  await t.test('identity baselines are encrypted references, immutable after first capture, and tenant-bound', async () => {
    const baseline = { version: 1, device: { android_id: 'test-only-device-id' }, sim: {} };
    assert.deepEqual(await scalar('select public.lock_device_identity($1,$2,$3) as result',[orgA,deviceA,JSON.stringify(baseline)]),baseline);
    assert.deepEqual(await scalar('select public.lock_device_identity($1,$2,$3) as result',[orgA,deviceA,JSON.stringify({ version: 1, device: { android_id: 'changed' }, sim: {} })]),baseline);
    assert.equal(await scalar('select public.get_device_identity($1,$2) as result',[orgB,deviceA]),null);
    await asUser(A);
    await assert.rejects(db.query('select public.get_device_identity($1,$2)',[orgA,deviceA]), /permission denied/);
  });
  await t.test('relocation clears prior environment and commits a new revision job together', async () => {
    const before = await scalar<number>('select environment_version as result from public.devices where id=$1',[deviceA]);
    await db.query("select public.control_station($1,$2,'relocate',29,-80,null,null,'88aa')",[orgA,deviceA]);
    const result = await db.query<{ environment_version:number; ssid:string|null; anchor_lat:number }>('select environment_version,ssid,anchor_lat from public.devices where id=$1',[deviceA]);
    assert.equal(result.rows[0]!.environment_version,before+1);
    assert.equal(result.rows[0]!.ssid,null);
    assert.equal(result.rows[0]!.anchor_lat,29);
    assert.equal(await scalar<number>("select count(*)::int as result from public.jobs where device_id=$1 and payload->>'environment_version'=$2",[deviceA,String(before+1)]),1);
  });
  await t.test('manual refresh increments revision and bypasses environment cache atomically', async () => {
    const job = await scalar<{ payload: Record<string,unknown> }>('select to_jsonb(public.refresh_environment($1,$2)) as result',[orgA,deviceA]);
    assert.equal(job.payload.force_refresh,true);
    assert.equal(job.payload.environment_version,3);
    await db.query('select public.set_environment_refresh($1,$2,true)',[orgA,deviceA]);
    assert.equal(await scalar('select environment_refresh_enabled as result from public.devices where id=$1',[deviceA]),true);
  });
  await t.test('job input cannot smuggle a different tenant key or fake target coordinates', async () => {
    await asUser(B);
    await assert.rejects(db.query("select public.enqueue_job($1,'device_sync',null,$2)",[orgB,JSON.stringify({key_id:keyA})]), /DuoPlus key not found/);
    const job = await scalar<{payload:Record<string,unknown>}>("select to_jsonb(public.enqueue_job($1,'environment_sync',$2,$3)) as result",[orgB,deviceB,JSON.stringify({target_lat:99,key_id:keyA})]);
    assert.deepEqual(job.payload,{environment_version:1,target_lat:30,target_lng:-81});
  });
  await t.test('WiGLE authorization is checked in the database, not only the frontend', async () => {
    await asUser(A);
    await assert.rejects(db.query("select public.store_credential($1,'wigle','wigle',$2)",[orgA,JSON.stringify({apiName:'test',apiToken:'test'})]), /commercial authorization required/);
  });
  await t.test('private Realtime topics authorize workspace membership', async () => {
    await db.exec('reset role;');
    await db.exec("insert into realtime.messages(id,extension,topic) values(1,'broadcast','test-fixture');");
    await asUser(A);
    await db.query("select set_config('realtime.topic',$1,false)",['org:'+orgA+':telemetry']);
    assert.equal(await scalar<number>('select count(*)::int as result from realtime.messages'),1);
    await db.query("select set_config('realtime.topic',$1,false)",['org:'+orgB+':telemetry']);
    assert.equal(await scalar<number>('select count(*)::int as result from realtime.messages'),0);
  });
  await t.test('route completion ignores stale controls and atomically reprovisions arrival', async () => {
    await asUser(A);
    await db.query("select public.control_station($1,$2,'navigate',null,null,$3,1.4)",[orgA,deviceA,JSON.stringify([[-80,29],[-79.9,29.1]])]);
    const version = await scalar<number>('select control_version as result from public.devices where id=$1',[deviceA]);
    await db.exec('reset role; set role service_role;');
    await db.query("select public.complete_route($1,$2,$3,29.1,-79.9,'88af')",[orgA,deviceA,version-1]);
    assert.equal(await scalar<number>('select control_version as result from public.devices where id=$1',[deviceA]),version);
    await db.query("select public.complete_route($1,$2,$3,29.1,-79.9,'88af')",[orgA,deviceA,version]);
    const result = await db.query<{status:string;anchor_lat:number;environment_version:number;control_version:number}>('select status,anchor_lat,environment_version,control_version from public.devices where id=$1',[deviceA]);
    assert.equal(result.rows[0]!.status,'STATIONARY');
    assert.equal(result.rows[0]!.anchor_lat,29.1);
    assert.equal(result.rows[0]!.control_version,version+1);
    assert.equal(await scalar<number>("select count(*)::int as result from public.jobs where device_id=$1 and payload->>'environment_version'=$2",[deviceA,String(result.rows[0]!.environment_version)]),1);
    await asUser(A);
    await assert.rejects(db.query("select public.complete_route($1,$2,$3,29.2,-79.8,'88af')",[orgA,deviceA,version]), /permission denied/);
  });
  await t.test('inventory snapshots enforce tenant isolation and worker-only writes', async () => {
    await db.exec('reset role; set role service_role;');
    await db.query("insert into public.fleet_inventory(org_id,key_id,devices,status) values($1,$2,'[]','ready')", [orgA,keyA]);
    await assert.rejects(db.query("update public.fleet_inventory set org_id=$1 where key_id=$2", [orgB,keyA]), /immutable|cannot/i);
    await asUser(A);
    assert.equal(await scalar<number>('select count(*)::int as result from public.fleet_inventory'), 1);
    await assert.rejects(db.query("update public.fleet_inventory set status='error'"), /permission denied/);
    await asUser(B);
    assert.equal(await scalar<number>('select count(*)::int as result from public.fleet_inventory'), 0);
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from public.fleet_inventory'), /permission denied/);
  });
  await t.test('credential deletion also deletes the underlying Vault secret', async () => {
    await db.exec('reset role;');
    const secretId = await scalar<string>('select vault_secret_id as result from private.credential_secrets where key_id=$1',[keyA]);
    await asUser(A);
    await db.query('select public.delete_credential($1)',[keyA]);
    await db.exec('reset role;');
    assert.equal(await scalar<number>('select count(*)::int as result from vault.secrets where id=$1',[secretId]),0);
    assert.equal(await scalar<number>('select count(*)::int as result from public.fleet_inventory'),0);
  });
  await db.close();
});
