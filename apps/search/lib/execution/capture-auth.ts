import { verifyCapture } from "./token";
import { admin, adminConfigured } from "../admin";
export async function captureAuth(request: Request) {
  if (!adminConfigured() || !process.env.CAPTURE_SIGNING_SECRET) return null;
  const runId = verifyCapture(
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "",
    process.env.CAPTURE_SIGNING_SECRET,
  );
  if (!runId) return null;
  const db = admin();
  const { data: run } = await db
    .from("search_runs")
    .select("id,org_id,status,routine_id")
    .eq("id", runId)
    .single();
  if (
    !run ||
    ![
      "submitting",
      "submitted",
      "running",
      "stopping",
      "completed",
      "attention",
    ].includes(run.status)
  )
    return null;
  return { db, run };
}
