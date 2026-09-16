import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {campaignInput} from './campaign-input';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const config={business:'Stakeout Search',listing:'https://stakeoutsearch.com',location:'Lakeland, FL',keywords:['local seo'],days:45,warmup:14,devices:5,concurrency:3,surfaces:['Chrome · Local Finder']};
test('campaign API rejects invalid plans and unsafe URLs',()=>{assert.equal(campaignInput.safeParse({...config,id:a,orgId:a}).success,true);for(const override of [{warmup:45},{concurrency:6},{listing:'javascript:alert(1)'},{surfaces:['invented']},{id:'bad'}])assert.equal(campaignInput.safeParse({...config,id:a,orgId:a,...override}).success,false);});
test('RLS isolates customer campaigns and denies member writes and activation',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema private;create table auth.users(id uuid primary key);create table public.organizations(id uuid primary key);create table public.org_members(org_id uuid,user_id uuid,role text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function private.is_member(oid uuid) returns boolean language sql stable as $$select exists(select 1 from public.org_members where org_id=oid and user_id=auth.uid())$$;grant usage on schema public,auth,private to authenticated;grant select on public.org_members to authenticated;insert into auth.users values('${a}'),('${b}');insert into organizations values('${a}'),('${b}');insert into org_members values('${a}','${a}','owner'),('${b}','${b}','owner');`);
 await db.exec(await readFile(new URL('../../../supabase/migrations/20260916170633_search_campaigns.sql',import.meta.url),'utf8'));
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${a}',false);`);
 await db.query('insert into search_campaigns(id,org_id,created_by,configuration) values($1,$2,$3,$4)',[a,a,a,config]);
 await assert.rejects(db.query('insert into search_campaigns(id,org_id,created_by,configuration) values($1,$2,$3,$4)',[b,b,a,config]));
 await db.exec(`select set_config('request.jwt.claim.sub','${b}',false)`);
 assert.equal((await db.query('select * from search_campaigns')).rows.length,0);
 await db.exec(`reset role;update org_members set role='member' where user_id='${a}';set role authenticated;select set_config('request.jwt.claim.sub','${a}',false);`);
 await assert.rejects(db.query('insert into search_campaigns(id,org_id,created_by,configuration) values($1,$2,$3,$4)',[b,a,a,config]));
 await assert.rejects(db.query("update search_campaigns set status='active' where id=$1",[a]));
 assert.equal((await db.query('select * from search_campaigns')).rows.length,1);
 }finally{await db.close();}
});
