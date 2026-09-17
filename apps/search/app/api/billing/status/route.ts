import { NextResponse } from "next/server";
import { authenticated } from "../../../../lib/request";
import { billingReady, plan, stripe } from "../../../../lib/billing/stripe";
export async function GET(request: Request) {
  const auth = await authenticated();
  if (auth.error) return auth.error;
  const org = new URL(request.url).searchParams.get("orgId");
  const { data, error } = await auth.client
    .from("search_billing")
    .select("status,device_limit,parallel_limit,valid_until")
    .eq("org_id", org)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Billing status unavailable" },
      { status: 503 },
    );
  let offer = null;
  if (billingReady()) {
    try {
      const p = plan();
      const price = await stripe().prices.retrieve(p.price);
      offer = {
        amount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval,
        devices: p.devices,
        parallel: p.parallel,
      };
    } catch {
      return NextResponse.json({
        configured: false,
        subscription: data,
        offer: null,
      });
    }
  }
  return NextResponse.json(
    { configured: billingReady(), subscription: data, offer },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
