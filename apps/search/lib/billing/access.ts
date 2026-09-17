import { NextResponse } from "next/server";
import { authenticated } from "../request";
export async function owner(orgId: string) {
  const auth = await authenticated();
  if (auth.error) return auth;
  const { data } = await auth.client
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", auth.user.id)
    .single();
  if (!data || data.role !== "owner")
    return {
      error: NextResponse.json(
        { error: "Workspace owner access required" },
        { status: 403 },
      ),
    };
  return auth;
}
