import Stripe from "stripe";
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw Error("Billing is not configured");
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 20000,
  });
}
export function plan() {
  const price = process.env.STRIPE_PRICE_ID,
    devices = Number(process.env.PLAN_DEVICE_LIMIT),
    parallel = Number(process.env.PLAN_PARALLEL_LIMIT);
  if (
    !price ||
    !Number.isInteger(devices) ||
    devices < 1 ||
    !Number.isInteger(parallel) ||
    parallel < 1 ||
    parallel > devices
  )
    throw Error("Subscription plan is not configured");
  return { price, devices, parallel };
}
export function billingReady() {
  try {
    plan();
    return Boolean(
      process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_WEBHOOK_SECRET &&
        process.env.SUPABASE_SECRET_KEY &&
        process.env.APP_URL,
    );
  } catch {
    return false;
  }
}
export function appUrl() {
  const url = new URL(process.env.APP_URL!);
  if (url.protocol !== "https:") throw Error("HTTPS app URL required");
  return url.origin;
}
