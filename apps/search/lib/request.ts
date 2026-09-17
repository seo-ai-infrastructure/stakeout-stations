import { NextResponse } from "next/server";
import { configured, serverClient } from "./supabase/server";
export async function authenticated() {
  if (!configured())
    return {
      error: NextResponse.json(
        { error: "Service configuration incomplete" },
        { status: 503 },
      ),
    };
  const client = await serverClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || data.user.is_anonymous)
    return {
      error: NextResponse.json(
        { error: "Sign in to continue" },
        { status: 401 },
      ),
    };
  return { client, user: data.user };
}
export function sameOrigin(request: Request) {
  const expected = process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : new URL(request.url).origin;
  return request.headers.get("origin") === expected;
}
