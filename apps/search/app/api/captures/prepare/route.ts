import { NextResponse } from "next/server";
import { captureAuth } from "../../../../lib/execution/capture-auth";
import { captureInput } from "../../../../lib/execution/contracts";
export async function POST(request: Request) {
  const auth = await captureAuth(request);
  if (!auth)
    return NextResponse.json(
      { error: "Invalid capture authorization" },
      { status: 401 },
    );
  let input;
  try {
    const body = await request.text();
    if (body.length > 16000) throw Error();
    input = captureInput.parse(JSON.parse(body));
    if (Math.abs(Date.now() - Date.parse(input.observedAt)) > 86400000)
      throw Error();
  } catch {
    return NextResponse.json(
      { error: "Invalid capture manifest" },
      { status: 400 },
    );
  }
  const { db, run } = auth;
  const quota = await db
    .from("search_captures")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id);
  if (quota.error)
    return NextResponse.json(
      { error: "Capture service unavailable" },
      { status: 503 },
    );
  if ((quota.count || 0) >= 100)
    return NextResponse.json(
      { error: "Capture limit reached for this run" },
      { status: 429 },
    );
  const artifacts = input.artifacts.map((a) => ({
    ...a,
    path: `${run.org_id}/${run.id}/${input.id}/${a.kind}.${a.kind === "xml" ? "xml" : a.mime === "image/png" ? "png" : a.mime === "image/jpeg" ? "jpg" : "mp4"}`,
  }));
  const { error } = await db.from("search_captures").insert({
    id: input.id,
    org_id: run.org_id,
    run_id: run.id,
    stage: input.stage,
    observed_at: input.observedAt,
    context: input.context,
    artifacts,
  });
  if (error)
    return NextResponse.json(
      { error: "Capture ID already used or unavailable; use a fresh ID." },
      { status: 409 },
    );
  const uploads = [];
  for (const a of artifacts) {
    const { data, error: e } = await db.storage
      .from("search-evidence")
      .createSignedUploadUrl(a.path, { upsert: false });
    if (e)
      return NextResponse.json(
        { error: "Upload authorization unavailable" },
        { status: 503 },
      );
    uploads.push({
      kind: a.kind,
      path: a.path,
      token: data.token,
      signedUrl: data.signedUrl,
      mime: a.mime,
    });
  }
  return NextResponse.json({ id: input.id, uploads }, { status: 201 });
}
