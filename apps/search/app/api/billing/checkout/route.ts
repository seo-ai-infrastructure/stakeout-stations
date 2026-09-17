import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sameOrigin } from "../../../../lib/request";
import { owner } from "../../../../lib/billing/access";
import { admin } from "../../../../lib/admin";
import {
  stripe,
  plan,
  appUrl,
  billingReady,
} from "../../../../lib/billing/stripe";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  let orgId: string;
  try {
    orgId = z.uuid().parse((await request.json()).orgId);
  } catch {
    return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  }
  const auth = await owner(orgId);
  if (auth.error) return auth.error;
  if (!billingReady())
    return NextResponse.json(
      { error: "Billing setup is not complete. No charge has been made." },
      { status: 503 },
    );
  const db = admin(),
    token = randomUUID();
  let locked = false;
  try {
    const lock = await db.rpc("search_billing_lock", {
      p_org: orgId,
      p_token: token,
    });
    if (lock.error || !lock.data)
      return NextResponse.json(
        { error: "Billing is updating. Please retry shortly." },
        { status: 409 },
      );
    locked = true;
    const s = stripe(),
      p = plan();
    const { data: b, error } = await db
      .from("search_billing")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw error;
    let customer = b?.customer_id;
    if (!customer) {
      const c = await s.customers.create(
        { metadata: { org_id: orgId } },
        { idempotencyKey: `stakeout-customer-${orgId}` },
      );
      customer = c.id;
      const saved = await db
        .from("search_billing")
        .upsert(
          { org_id: orgId, customer_id: customer },
          { onConflict: "org_id", ignoreDuplicates: true },
        );
      if (saved.error) throw saved.error;
    }
    // Query Stripe itself: a successful checkout can precede its webhook.
    const subscriptions = await s.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
    });
    if (
      subscriptions.has_more ||
      subscriptions.data.some(
        (x) => !["canceled", "incomplete_expired"].includes(x.status),
      )
    )
      return NextResponse.json(
        { error: "Use Manage billing for your existing subscription." },
        { status: 409 },
      );
    const pending = await s.checkout.sessions.list({
      customer,
      status: "open",
      limit: 100,
    });
    if (pending.has_more) throw Error("Checkout reconciliation required");
    const existing = pending.data.find(
      (x) => x.mode === "subscription" && x.metadata?.org_id === orgId && x.url,
    );
    if (existing) return NextResponse.json({ url: existing.url });
    const price = await s.prices.retrieve(p.price);
    if (!price.active || !price.recurring)
      throw Error("Recurring price unavailable");
    const renewed = await db.rpc("search_billing_lock", {
      p_org: orgId,
      p_token: token,
    });
    if (renewed.error || !renewed.data) throw Error("Billing lease lost");
    const bucket = Math.floor(Date.now() / 1800000);
    const session = await s.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        line_items: [{ price: p.price, quantity: 1 }],
        client_reference_id: orgId,
        metadata: { org_id: orgId },
        subscription_data: { metadata: { org_id: orgId } },
        success_url: appUrl() + "/?billing=processing",
        cancel_url: appUrl() + "/?billing=canceled",
        expires_at: (bucket + 2) * 1800,
      },
      { idempotencyKey: `stakeout-checkout-${orgId}-${bucket}` },
    );
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json(
      { error: "Checkout could not be opened. Please retry." },
      { status: 502 },
    );
  } finally {
    if (locked)
      await db.rpc("search_billing_unlock", { p_org: orgId, p_token: token });
  }
}
