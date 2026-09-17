import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { admin } from "../../../../lib/admin";
import { stripe, plan, billingReady } from "../../../../lib/billing/stripe";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!billingReady())
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  const raw = await request.text();
  if (raw.length > 1000000) return new NextResponse(null, { status: 413 });
  const s = stripe();
  let event;
  try {
    event = s.webhooks.constructEvent(
      raw,
      request.headers.get("stripe-signature") || "",
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (
    !event.type.startsWith("customer.subscription.") &&
    ![
      "checkout.session.completed",
      "invoice.paid",
      "invoice.payment_failed",
    ].includes(event.type)
  )
    return NextResponse.json({ received: true });
  try {
    const object = event.data.object as unknown as {
      customer?: string | { id: string };
    };
    const customer =
      typeof object.customer === "string"
        ? object.customer
        : object.customer?.id;
    if (!customer) return NextResponse.json({ received: true });
    const db = admin();
    const { data: b, error } = await db
      .from("search_billing")
      .select("*")
      .eq("customer_id", customer)
      .maybeSingle();
    if (error) throw error;
    if (!b) return NextResponse.json({ received: true });
    const token = randomUUID();
    const lock = await db.rpc("search_billing_lock", {
      p_org: b.org_id,
      p_token: token,
    });
    if (lock.error || !lock.data) throw Error("Billing update busy");
    // Re-read current Stripe state while holding the per-workspace lease: event order is not trusted.
    const subscriptions = await s.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
    });
    if (subscriptions.has_more)
      throw Error("Subscription reconciliation requires review");
    const p = plan();
    const matching = subscriptions.data.filter((x) =>
      x.items.data.some((i) => i.price.id === p.price),
    );
    const subscription =
      matching.find((x) => ["active", "trialing"].includes(x.status)) ||
      matching.sort((a, b) => b.created - a.created)[0];
    const item = subscription?.items.data.find((i) => i.price.id === p.price);
    const enabled =
      subscription &&
      ["active", "trialing"].includes(subscription.status) &&
      !subscription.pause_collection;
    const result = await db.rpc("search_billing_apply", {
      p_org: b.org_id,
      p_token: token,
      p_event: event.id,
      p_subscription: subscription?.id || null,
      p_status: subscription?.status || "inactive",
      p_price: item?.price.id || null,
      p_devices: enabled ? p.devices : 0,
      p_parallel: enabled ? p.parallel : 0,
      p_until: item?.current_period_end
        ? new Date(item.current_period_end * 1000).toISOString()
        : null,
    });
    if (result.error) throw result.error;
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json(
      { error: "Reconciliation pending; retry delivery" },
      { status: 503 },
    );
  }
}
