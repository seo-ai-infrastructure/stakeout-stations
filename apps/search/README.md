# Stakeout Search

Managed local-search observation workspace. Customer UI: https://stakeout-search-app.vercel.app. Marketing homepage and white-label page are outside this app.

## Run locally

```sh
npm ci
npm test
npm run build
npm start
```

Run from `apps/search`, not the incomplete repository root. Copy `.env.example` and configure public Supabase settings for authentication. `/demo` contains explicitly illustrative data; the authenticated root uses organization-scoped records.

## Services

- **Vercel:** Next.js UI, email-link authentication, workspace and campaign drafts. Operational API routes proxy to `SEARCH_BACKEND_ORIGIN`; privileged keys never reach browser bundles.
- **Railway search-api:** the same Next.js API code, Supabase server credentials, Stripe integration and private evidence ingestion. Build `Dockerfile.api` with root `/apps/search`. Health: `/api/health`.
- **Railway search-worker:** persistent task dispatcher, build `Dockerfile.worker`, root `/apps/search`, health `/health`. Starts with `SEARCH_WORKER_ENABLED=false`, `SEARCH_MAX_SLOTS=0`.
- **Supabase:** existing organizations/members plus search campaigns, subscriptions, assigned devices, approved templates, routines, durable runs and captures. The private `search-evidence` bucket serves five-minute signed playback links.

Existing station services and their credentials are not changed. The new services can reference the existing project's Supabase server credential through Railway reference variables. Do not set `SEARCH_BACKEND_ORIGIN` on search-api (that would proxy back to itself).

## Authentication callback

Project **stakeout-stations**, `rgaxccniacasrabfnpsp`:
https://supabase.com/dashboard/project/rgaxccniacasrabfnpsp/auth/url-configuration

Add `https://stakeout-search-app.vercel.app/auth/callback` to Redirect URLs. Retain the existing Site URL and entries. Email round-trip remains unverified until this account setting is confirmed.

## Billing activation

On **search-api**, configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, an active recurring `STRIPE_PRICE_ID`, and positive `PLAN_DEVICE_LIMIT` / `PLAN_PARALLEL_LIMIT` (parallel must not exceed devices). Set `APP_URL` to the Vercel app origin. Configure Stripe's customer portal.

Webhook URL: `https://stakeout-search-app.vercel.app/api/billing/webhook`. Subscribe to `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, and `invoice.payment_failed`. Raw-body signature verification is required. Webhooks re-read current Stripe subscriptions under a database lease, so delayed events do not replay stale subscription state. Event IDs are deduplicated transactionally. No amount or entitlement is taken from browser input. One configured plan is supported in this release.

Owners can subscribe/manage billing. Scheduling requires an active or trialing subscription with an unexpired period and valid allowances. Checkout checks existing Stripe subscriptions and reuses open sessions. Test-mode payment, renewal, failure, cancellation, and portal flows must pass before accepting live payments. No prices or paid subscriptions are created by this code's deployment.

## Device scheduling activation

1. Set a company-managed `DUOPLUS_API_KEY`, its actual `DUOPLUS_TIMEZONE`, and an operator-approved `SEARCH_MAX_SLOTS` on search-worker. Never use customer/provider keys in browser configuration.
2. Operators register existing assigned devices in `search_managed_devices` (one organization per device), and validated DuoPlus templates in `search_templates`. Templates and devices default to disabled. Match the provider's variable schema exactly; only reviewed templates should be enabled.
3. Configure the same random `CAPTURE_SIGNING_SECRET` (at least 32 characters) on API and worker. Capture-enabled templates must accept `stakeout_run_id`, `stakeout_capture_token`, `stakeout_capture_url` and export their real artifacts using the protocol below.
4. Enroll a paid pilot workspace, assign its dedicated devices, approve its templates, then enable the worker. An existing external controller must not also control those devices. Use a dedicated provider pool or coordinate controllers: inventory can count externally powered devices but cannot lock another controller's pending power-on requests.

Customers schedule daily/weekly (or N-day) routines with custom variables, first-run time and count. Repetition uses fixed UTC day intervals; local wall-clock time can shift across daylight-saving changes. Pausing stops future dispatch; it does not cancel a provider task already submitted. This version does not automatically provision/reset devices, buy proxies, create accounts, or generate warmup routines.

Dispatch serializes shared slot allocation, checks current provider subscription capacity, counts externally powered/unknown devices, enforces plan and campaign parallel limits, and prevents overlapping use of a device. The provider gate spaces calls at least 1.25 seconds apart. Reserved slots stay held through shutdown confirmation. An ambiguous task submission is reconciled by its unique name; it is never blindly retried. `attention` runs intentionally retain their slot until reconciled. Operators must confirm provider task and power state before manually resolving an attention run; never clear it just because a lease elapsed.

## Real capture ingestion

The worker supplies a run-scoped, expiring HMAC token to the approved RPA template. That template/controlled ADB runner must collect and upload real artifacts. Scheduling alone does not create a screen recording.

`POST /api/captures/prepare` with Bearer token and this manifest (local upload helper also accepts `file` on artifacts):

```json
{
  "stage": "local-finder",
  "observedAt": "2026-09-17T12:00:00.000Z",
  "context": {
    "surface": "Chrome Local Finder",
    "keyword": "local seo",
    "lat": 28.0395,
    "lng": -81.9498,
    "locationVerified": false,
    "locationEvidence": "Not independently verified",
    "viewport": {"width": 1080, "height": 2340}
  },
  "artifacts": [
    {"kind": "xml", "mime": "application/xml", "file": "window.xml"},
    {"kind": "screenshot", "mime": "image/png", "file": "screen.png"},
    {"kind": "video", "mime": "video/mp4", "file": "recording.mp4"}
  ]
}
```

Supply a UUID `id` and each file's `bytes` for direct HTTP calls. The helper generates them:

```sh
# Set STAKEOUT_CAPTURE_URL and STAKEOUT_CAPTURE_TOKEN securely in the runner environment.
node scripts/upload-capture.mjs manifest.json
```

The helper streams files directly to the returned signed storage upload URLs, then calls `/api/captures/complete`. File sizes, MIME types and signatures are checked before evidence becomes visible. XML and screenshots receive SHA-256 hashes; video header is range-checked (no whole-video hash). XML entities/DTDs are rejected and offscreen/hidden nodes excluded. A successful provider task without uploaded evidence still shows no capture.

A retry of `/complete` for the same ID is idempotent. If upload fails, retain the capture ID printed by the helper; retry missing artifacts using the original signed URLs before completing. No fake screenshot/video is inserted for demonstration. GPS/IP context is capture-runner-reported, not an independent attestation. Visible XML text is extracted; surface-specific rank classification and competitor matching remain follow-up work.

## Verification and remaining activation

See `VERIFICATION.md`. Live Stripe transactions, customer email login, and actual DuoPlus artifact capture require configured credentials and a pilot. Code and database tests do not replace these live integration checks. No paid provider executions are triggered during deployment.

Official interfaces: https://docs.stripe.com/billing/subscriptions/webhooks and https://help.duoplus.net/docs/Create-Scheduled-Task. Stripe SDK is pinned; provider endpoints are called only by the server worker.
