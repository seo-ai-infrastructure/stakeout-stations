import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { captureAuth } from "../../../../lib/execution/capture-auth";
import { visibleText, fileSignature } from "../../../../lib/execution/xml";
export const maxDuration = 60;
export async function POST(request: Request) {
  const auth = await captureAuth(request);
  if (!auth)
    return NextResponse.json(
      { error: "Invalid capture authorization" },
      { status: 401 },
    );
  let id;
  try {
    id = z.uuid().parse((await request.json()).id);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const { db, run } = auth;
  const { data: c } = await db
    .from("search_captures")
    .select("*")
    .eq("id", id)
    .eq("run_id", run.id)
    .eq("org_id", run.org_id)
    .single();
  if (!c) return new NextResponse(null, { status: 404 });
  if (c.status === "ready") return NextResponse.json({ id, status: "ready" });
  if (c.status !== "uploading") return new NextResponse(null, { status: 409 });
  try {
    let text = null;
    const checked = [];
    for (const a of c.artifacts) {
      const prefix = a.path.slice(0, a.path.lastIndexOf("/")),
        name = a.path.slice(a.path.lastIndexOf("/") + 1);
      const { data: objects, error } = await db.storage
        .from("search-evidence")
        .list(prefix, { search: name, limit: 10 });
      const object = objects?.find((o) => o.name === name);
      if (
        error ||
        !object ||
        Number(object.metadata?.size) !== a.bytes ||
        object.metadata?.mimetype !== a.mime
      )
        throw Error("Missing or mismatched artifact");
      let hash = null;
      if (a.kind === "xml" || a.kind === "screenshot") {
        const { data: blob, error: e } = await db.storage
          .from("search-evidence")
          .download(a.path);
        if (e || !blob) throw Error("Artifact unavailable");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!fileSignature(a.kind, a.mime, bytes))
          throw Error("Artifact format mismatch");
        hash = createHash("sha256").update(bytes).digest("hex");
        if (a.kind === "xml")
          text = visibleText(
            new TextDecoder().decode(bytes),
            c.context.viewport.width,
            c.context.viewport.height,
          );
      } else {
        const { data: u, error: e } = await db.storage
          .from("search-evidence")
          .createSignedUrl(a.path, 60);
        if (e || !u) throw Error("Video unavailable");
        const response = await fetch(u.signedUrl, {
          headers: { Range: "bytes=0-31" },
          signal: AbortSignal.timeout(10000),
        });
        if (response.status !== 206) {
          await response.body?.cancel();
          throw Error("Video range verification unavailable");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!fileSignature(a.kind, a.mime, bytes))
          throw Error("Video format mismatch");
      }
      checked.push({ ...a, sha256: hash });
    }
    const result = await db
      .from("search_captures")
      .update({ status: "ready", artifacts: checked, visible_text: text })
      .eq("id", id)
      .eq("status", "uploading");
    if (result.error) throw result.error;
    return NextResponse.json({ id, status: "ready" });
  } catch {
    return NextResponse.json(
      {
        error:
          "Evidence is incomplete or invalid. Upload all declared artifacts, then retry completion.",
      },
      { status: 422 },
    );
  }
}
