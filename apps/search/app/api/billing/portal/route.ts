import { NextResponse } from "next/server";
import { z } from "zod";
import { sameOrigin } from "../../../../lib/request";
import { owner } from "../../../../lib/billing/access";
import { admin } from "../../../../lib/admin";
import { stripe, appUrl, billingReady } from "../../../../lib/billing/stripe";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  let id;
  try {
    id = z.uuid().parse((await request.json()).orgId);
  } catch {
    return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  }
  const auth = await owner(id);
  if (auth.error) return auth.error;
  if (!billingReady())
    return NextResponse.json(
      { error: "Billing is not configured" },
      { status: 503 },
    );
  try {
    const { data } = await admin()
      .from("search_billing")
      .select("customer_id")
      .eq("org_id", id)
      .single();
    if (!data?.customer_id)
      return NextResponse.json(
        { error: "No billing account yet" },
        { status: 409 },
      );
    const session = await stripe().billingPortal.sessions.create({
      customer: data.customer_id,
      return_url: appUrl(),
    });
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json(
      { error: "Billing portal unavailable" },
      { status: 502 },
    );
  }
}
