import { NextResponse } from "next/server";
import { admin } from "../../../lib/admin";
export async function GET() {
  try {
    const { error } = await admin().from("search_runs").select("id").limit(0);
    if (error) throw error;
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
