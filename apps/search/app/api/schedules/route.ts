import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticated, sameOrigin } from "../../../lib/request";
import { admin, adminConfigured } from "../../../lib/admin";
import {
  scheduleInput,
  resolveVariables,
} from "../../../lib/execution/contracts";
export async function GET(request: Request) {
  const auth = await authenticated();
  if (auth.error) return auth.error;
  const org = new URL(request.url).searchParams.get("orgId");
  if (!z.uuid().safeParse(org).success)
    return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  const results = await Promise.all([
    auth.client
      .from("search_managed_devices")
      .select("id,name,enabled")
      .eq("org_id", org),
    auth.client.from("search_templates").select("*").eq("enabled", true),
    auth.client
      .from("search_routines")
      .select("*")
      .eq("org_id", org)
      .order("created_at", { ascending: false })
      .limit(200),
    auth.client
      .from("search_runs")
      .select("*")
      .eq("org_id", org)
      .order("due_at", { ascending: false })
      .limit(300),
  ]);
  if (results.some((r) => r.error))
    return NextResponse.json(
      { error: "Schedule could not be loaded" },
      { status: 503 },
    );
  return NextResponse.json(
    {
      devices: results[0].data,
      templates: results[1].data,
      routines: results[2].data,
      runs: results[3].data,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await authenticated();
  if (auth.error) return auth.error;
  if (!adminConfigured())
    return NextResponse.json(
      { error: "Scheduler setup is pending" },
      { status: 503 },
    );
  let input;
  try {
    input = scheduleInput.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid schedule" }, { status: 400 });
  }
  const { data: member } = await auth.client
    .from("org_members")
    .select("role")
    .eq("org_id", input.orgId)
    .eq("user_id", auth.user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role))
    return NextResponse.json(
      { error: "Owner or admin access required" },
      { status: 403 },
    );
  try {
    const db = admin();
    const { data: t } = await db
      .from("search_templates")
      .select("*")
      .eq("id", input.templateId)
      .eq("enabled", true)
      .single();
    if (!t)
      return NextResponse.json(
        { error: "Choose an approved template" },
        { status: 400 },
      );
    const variables = resolveVariables(t.variable_schema, input.variables);
    const { data, error } = await db.rpc("search_schedule", {
      p_org: input.orgId,
      p_campaign: input.campaignId,
      p_device: input.deviceId,
      p_id: input.id,
      p_name: input.name,
      p_template: t.id,
      p_type: t.template_type,
      p_vars: variables,
      p_surface: input.surface,
      p_keyword: input.keyword,
      p_start: input.startAt,
      p_count: input.count,
      p_interval: input.intervalDays,
    });
    if (error)
      return NextResponse.json(
        {
          error:
            "Cannot schedule: check subscription, device assignment, plan limits, and campaign duration.",
        },
        { status: 409 },
      );
    return NextResponse.json({ id: data }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Check required template variables" },
      { status: 400 },
    );
  }
}
export async function PATCH(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await authenticated();
  if (auth.error) return auth.error;
  if (!adminConfigured())
    return NextResponse.json(
      { error: "Scheduler setup is pending" },
      { status: 503 },
    );
  let x;
  try {
    x = z
      .object({ orgId: z.uuid(), routineId: z.uuid(), enabled: z.boolean() })
      .parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { data: m } = await auth.client
    .from("org_members")
    .select("role")
    .eq("org_id", x.orgId)
    .eq("user_id", auth.user.id)
    .single();
  if (!m || !["owner", "admin"].includes(m.role))
    return new NextResponse(null, { status: 403 });
  const { data, error } = await admin()
    .from("search_routines")
    .update({ enabled: x.enabled })
    .eq("id", x.routineId)
    .eq("org_id", x.orgId)
    .select("id")
    .single();
  if (error)
    return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  return NextResponse.json({ id: data.id, enabled: x.enabled });
}
