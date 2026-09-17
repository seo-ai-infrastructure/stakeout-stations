import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Stripe from "stripe";
import { signCapture, verifyCapture } from "./execution/token";
import { visibleText, fileSignature } from "./execution/xml";
import { resolveVariables, captureInput } from "./execution/contracts";
import { DuoPlus, providerDate, power } from "../worker/provider";
test("capture authorization is scoped, expires, and rejects tampering", () => {
  const secret = "s".repeat(40),
    id = randomUUID(),
    token = signCapture(id, secret, 1000);
  assert.equal(verifyCapture(token, secret, 2000), id);
  assert.equal(verifyCapture(token + "x", secret, 2000), null);
  assert.equal(verifyCapture(token, secret, 22000000), null);
  assert.equal(verifyCapture(token, "other".repeat(10), 2000), null);
});
test("XML extractor ignores offscreen nodes and refuses entities", () => {
  const xml =
    '<hierarchy><node text="Visible" bounds="[0,0][50,50]"/><node text="Offscreen" bounds="[0,500][50,600]"/><node text="Hidden" visible-to-user="false" bounds="[0,0][10,10]"/></hierarchy>';
  assert.deepEqual(
    visibleText(xml, 100, 100).map((n) => n.text),
    ["Visible"],
  );
  assert.throws(() => visibleText("<!DOCTYPE a><hierarchy/>", 100, 100));
  assert.equal(
    fileSignature("video", "video/mp4", Buffer.from("not a video")),
    false,
  );
});
test("template variables cannot override capture credentials", () => {
  assert.throws(() =>
    resolveVariables(
      { stakeout_capture_token: { type: "string", required: true } },
      { stakeout_capture_token: "fake" },
    ),
  );
  assert.throws(() =>
    resolveVariables({ keyword: { type: "string", required: true } }, {}),
  );
  assert.equal(
    resolveVariables(
      { keyword: { type: "string", required: true } },
      { keyword: "local seo" },
    ).keyword.value,
    "local seo",
  );
});
test("capture manifest rejects MIME mismatches and duplicate artifacts", () => {
  const c = {
    id: randomUUID(),
    stage: "finder",
    observedAt: new Date().toISOString(),
    context: {
      surface: "Maps",
      keyword: "seo",
      lat: 0,
      lng: 0,
      locationVerified: false,
      locationEvidence: "",
      viewport: { width: 1080, height: 2340 },
    },
    artifacts: [{ kind: "xml", mime: "video/mp4", bytes: 100 }],
  };
  assert.equal(captureInput.safeParse(c).success, false);
});
test("Stripe rejects altered signed webhook payloads", () => {
  const stripe = new Stripe("sk_test_fixture"),
    secret = "whsec_fixture",
    payload = JSON.stringify({ id: "evt_test", object: "event" });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(
    stripe.webhooks.constructEvent(payload, header, secret).id,
    "evt_test",
  );
  assert.throws(() =>
    stripe.webhooks.constructEvent(payload + " ", header, secret),
  );
});
test("DuoPlus mutation errors are not retried automatically", async () => {
  let calls = 0;
  const provider = new DuoPlus(
    "test",
    async () => {},
    async () => {
      calls++;
      throw Error("Timeout");
    },
  );
  await assert.rejects(provider.setPower("phone", true));
  assert.equal(calls, 1);
  assert.equal(power(99), "unknown");
  assert.equal(
    providerDate(new Date("2026-01-01T15:00:00Z"), "America/New_York"),
    "2026-01-01 10:00",
  );
});
test("durable pool enforces slots, holds uncertain runs, and denies public RPCs", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create schema storage;create table auth.users(id uuid primary key);create table organizations(id uuid primary key);create table org_members(org_id uuid,user_id uuid,role text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function private.is_member(oid uuid) returns boolean language sql stable as $$select exists(select 1 from org_members where org_id=oid and user_id=auth.uid())$$;grant usage on schema public,private,auth to authenticated,service_role;grant select on org_members to authenticated;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
    );
    await db.exec(
      await readFile(
        new URL(
          "../../../supabase/migrations/20260916170633_search_campaigns.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../../../supabase/migrations/20260917070007_search_billing_execution.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const org = randomUUID(),
      user = randomUUID(),
      campaign = randomUUID(),
      device = randomUUID(),
      routine = randomUUID(),
      leader = randomUUID();
    const config = {
      business: "Stakeout",
      listing: "https://stakeoutsearch.com",
      location: "Lakeland",
      keywords: ["seo"],
      days: 45,
      warmup: 14,
      devices: 2,
      concurrency: 1,
      surfaces: ["Maps"],
    };
    await db.query("insert into organizations values($1)", [org]);
    await db.query("insert into auth.users values($1)", [user]);
    await db.query("insert into org_members values($1,$2,$3)", [
      org,
      user,
      "owner",
    ]);
    await db.query(
      "insert into search_campaigns(id,org_id,created_by,configuration) values($1,$2,$3,$4)",
      [campaign, org, user, config],
    );
    await db.query(
      "insert into search_billing(org_id,status,device_limit,parallel_limit,valid_until) values($1,'active',2,1,now()+interval '1 day')",
      [org],
    );
    await db.query(
      "insert into search_managed_devices(id,org_id,provider_id,name,enabled,power,observed_at) values($1,$2,'phone','Phone',true,'off',now())",
      [device, org],
    );
    await db.exec(
      "insert into search_templates(id,name,template_type,enabled) values('template','Approved',2,true)",
    );
    await db.query(
      "select search_schedule($1,$2,$3,$4,'Daily','template',2,'{}','Maps','seo',now(),2,1)",
      [org, campaign, device, routine],
    );
    assert.equal((await db.query("select * from search_runs")).rows.length, 2);
    await db.query("select search_worker_leader($1)", [leader]);
    await db.query(
      'select search_worker_inventory($1,0,1,\'{"phone":"off"}\')',
      [leader],
    );
    const claimed = await db.query("select * from search_claim($1)", [leader]);
    assert.equal(claimed.rows.length, 1);
    assert.equal(
      (await db.query("select * from search_claim($1)", [leader])).rows.length,
      0,
    );
    await db.query("update search_runs set status='attention' where id=$1", [
      (claimed.rows[0] as any).id,
    ]);
    assert.equal(
      (await db.query("select * from search_claim($1)", [leader])).rows.length,
      0,
    );
    // Increasing the account and provider allowance must not bypass a campaign limit.
    const otherDevice=randomUUID();
    await db.query("insert into search_managed_devices(id,org_id,provider_id,name,enabled,power,observed_at) values($1,$2,'phone2','Second',true,'off',now())",[otherDevice,org]);
    await db.query("update search_billing set parallel_limit=2 where org_id=$1",[org]);
    await db.query("select search_schedule($1,$2,$3,$4,'Second','template',2,'{}','Maps','seo',now(),1,1)",[org,campaign,otherDevice,randomUUID()]);
    await db.query("select search_worker_inventory($1,0,2,$2)",[leader,JSON.stringify({phone:'off',phone2:'off'})]);
    assert.equal((await db.query("select * from search_claim($1)",[leader])).rows.length,0);
    // Another worker cannot mutate a reservation, and stale inventory cannot allocate.
    assert.equal((await db.query("select search_run_update($1,$2,'attention','failed') ok",[randomUUID(),(claimed.rows[0] as any).id])).rows[0].ok,false);
    await db.query("update search_runs set status='failed' where id=$1",[(claimed.rows[0] as any).id]);
    await db.exec("update private.search_pool set observed_at=now()-interval '1 minute'");
    assert.equal((await db.query("select * from search_claim($1)",[leader])).rows.length,0);
    // Leases serialize billing changes and event replay cannot replace an applied event.
    const billingToken=randomUUID();
    assert.equal((await db.query('select search_billing_lock($1,$2) ok',[org,billingToken])).rows[0].ok,true);
    assert.equal((await db.query('select search_billing_lock($1,$2) ok',[org,randomUUID()])).rows[0].ok,false);
    await db.query("select search_billing_apply($1,$2,'evt_fixture','sub_fixture','active','price_fixture',2,2,now()+interval '1 day')",[org,billingToken]);
    await db.query('select search_billing_lock($1,$2)',[org,billingToken]);
    await db.query("select search_billing_apply($1,$2,'evt_fixture',null,'canceled',null,0,0,null)",[org,billingToken]);
    assert.equal((await db.query('select status from search_billing where org_id=$1',[org])).rows[0].status,'active');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[randomUUID()]);
    await db.exec("set role authenticated");
    for(const table of ['search_billing','search_managed_devices','search_routines','search_runs','search_captures'])assert.equal((await db.query('select * from '+table)).rows.length,0);

    await assert.rejects(db.query("select * from search_claim($1)", [leader]));
    await assert.rejects(db.exec("update search_billing set status='active'"));
    await assert.rejects(db.exec("select * from private.search_pool"));
    await db.exec("reset role");
    await db.query(
      "update search_billing set status='past_due' where org_id=$1",
      [org],
    );
    await assert.rejects(
      db.query(
        "select search_schedule($1,$2,$3,$4,'Other','template',2,'{}','Maps','seo',now(),1,1)",
        [org, campaign, device, randomUUID()],
      ),
    );
  } finally {
    await db.close();
  }
});
