# Preview verification — 2026-09-16

## Executed checks

- Next.js optimized production build: passed.
- TypeScript: passed.
- Campaign validation and corrupt-storage tests: 3 passed.
- Local Chromium: new campaign form, save, reload, campaign selection, and return to sample workspace passed.
- Selecting an unavailable observation showed capture-missing state rather than a ranking claim.
- Desktop viewport 1499 × 1049 and mobile viewport 390 × 844 inspected. Mobile document width equals viewport width; no page overflow. Schedule uses its own horizontal scroll area.
- No uncaught application JavaScript exceptions during the tested flow.

The connected Browser tool could not open the local server (`ERR_BLOCKED_BY_CLIENT`), so local Playwright Chromium was used. CARTO raster requests fail with `ERR_EMPTY_RESPONSE` in this environment; the fallback message and location-selection list were verified, but successful tile rendering still needs a network-enabled deployment check.

## Concept comparison ledger

The approved generated concept and desktop/mobile render screenshots were opened with view_image.

| Point | Comparison and disposition |
| --- | --- |
| Structure | Preserved fixed desktop rail, heading, lifecycle, three metrics, tabs, map/evidence split, and schedule. |
| Palette | Charcoal surfaces, emerald selection/tracking, and amber warmup retained. |
| Typography | Explicit heading/control/body sizes; native browser controls inherit the app font. Arial fallback differs from the generated typeface. |
| Evidence | Intentionally removed fabricated playback and completion checks; actual media is not available. |
| Copy | Intentional changes identify sample devices, example tasks, and no live connection. No “all systems operational” claim. |
| Competitors | Added paired example competitor rows for the selected observation; panel is taller than the original concept. |
| Map | Fixed a CSS load-order bug that collapsed canvas height. Geographic markers are selectable; unavailable external tiles prevent complete visual parity. |
| Responsive | Rail becomes labeled mobile navigation; map and evidence stack; draft dialog remains within the viewport. |

This is a functional preview, not full design or production sign-off. Tile rendering and live evidence playback are explicitly unverified. Auth, payments, tenant persistence, scheduling, capture ingestion, and provisioning remain unimplemented in this app.

## Account release checks

- Added schema/API validation and actual PostgreSQL RLS tests using PGlite: 5 tests pass in total.
- Verified owner insertion; foreign-workspace insertion denied; foreign-workspace reads empty; member insertion denied; client status mutation denied.
- Hosted database verification: RLS enabled, two policies present, anon SELECT denied, authenticated UPDATE denied.
- Hosted `/api/campaigns`: HTTP 401 for signed-out requests, private/no-store response.
- Connected Browser loaded the deployed login form. Email round-trip and an authenticated production save are not tested because the Auth callback allowlist cannot be managed by the available connector.
- Supabase security advisor reported no new table-policy warnings. Existing project warning: leaked-password protection disabled (this app uses email-link auth); unrelated private credential tables intentionally have no browser policies. See https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection.
- Existing marketing homepage and white-label page were not modified or redeployed.

## Billing, scheduling and ingestion release — September 17

Supersedes earlier statements that these modules were unimplemented:

- Production Next.js build and TypeScript pass; 12 automated tests pass.
- Stripe signature tampering is rejected. Database tests verify exclusive billing leases and event deduplication.
- Real PostgreSQL migration tests exercise queued recurring runs, shared device capacity, campaign concurrency, retained uncertain reservations, stale inventory, worker fencing and unpaid scheduling rejection.
- Browser roles cannot call privileged scheduler RPCs or mutate billing; organization isolation is exercised for operation tables.
- Capture tests exercise expiring/scoped tokens, reserved variables, artifact MIME validation, XML entity rejection and visible-node extraction.
- No live Stripe payment, DuoPlus device task, or real artifact upload has been performed. Video playback, approved-template variable compatibility, and provider reconciliation still need a configured pilot.
- The schema is additive. New device/template defaults and worker configuration prevent automatic provider execution on deployment.
