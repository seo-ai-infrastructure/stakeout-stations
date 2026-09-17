import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticated } from "../../../lib/request";
import { admin, adminConfigured } from "../../../lib/admin";
export async function GET(request: Request) {
  const auth = await authenticated();
  if (auth.error) return auth.error;
  const url = new URL(request.url),
    org = url.searchParams.get("orgId"),
    run = url.searchParams.get("runId");
  if (!z.uuid().safeParse(org).success || !z.uuid().safeParse(run).success)
    return new NextResponse(null, { status: 400 });
  const { data, error } = await auth.client
    .from("search_captures")
    .select("*")
    .eq("org_id", org)
    .eq("run_id", run)
    .eq("status", "ready")
    .order("observed_at");
  if (error) return new NextResponse(null, { status: 503 });
  if (!adminConfigured())
    return NextResponse.json(
      { error: "Evidence access setup is pending" },
      { status: 503 },
    );
  const db = admin();
  const captures = [];
  for (const c of data) {
    const artifacts = [];
    for (const a of c.artifacts) {
      const { data: link, error: e } = await db.storage
        .from("search-evidence")
        .createSignedUrl(a.path, 300);
      if (e)
        return NextResponse.json(
          { error: "Evidence temporarily unavailable" },
          { status: 503 },
        );
      artifacts.push({ ...a, url: link.signedUrl });
    }
    captures.push({ ...c, artifacts });
  }
  return NextResponse.json(
    { captures },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
