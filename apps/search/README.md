# Stakeout Search — customer workspace preview

An isolated Next.js application for the managed search product. The existing station console and Railway worker are unchanged. Run commands from this directory, not the incomplete repository root.

```sh
npm ci
npm test
npm run build
npm start
```

Set a Vercel project's root directory to `apps/search` to build this app. No provider environment variables are needed for this **local-data preview**. This branch is not linked to or deployed over the existing production services.

## Implemented

- Responsive campaign workspace based on the approved dark command-center concept.
- MapLibre geographic map with selectable sample observations and paired competitor details.
- Explicit missing-capture semantics; no simulated playable recordings or success events.
- Accessible native campaign dialog with duration/capacity/surface validation.
- Browser-persisted drafts, campaign selection, and JSON draft export.
- Sample schedules, device inventory, and managed-service settings.

## Launch gates still open

This is not yet a production SaaS or an activated campaign engine. Browser drafts are not authenticated, synchronized customer records. Checkout does not exist. No live provider call is made. Models, per-device locations/proxies, routine templates, scheduling, and reset/provisioning need backend integration.

Next work: organization-scoped Supabase campaign persistence and authentication; Stripe checkout/webhook entitlements; managed credential storage separate from the existing BYOK console; a durable scheduler with shared capacity leases and reconciliation; capture ingestion and extraction; private screenshot/XML/video storage with signed playback access; measured pilot reports. Do not charge for automated fulfillment until the corresponding end-to-end path is verified.

The map uses CARTO raster tiles with OpenStreetMap attribution for this preview. Confirm a production tile plan before commercial launch.

## Design system

Charcoal background `#0e1318`, panels `#171d23`, borders `#2a323b`, emerald `#36e5ac`, warmup amber `#f0b937`. Desktop rail 220 px; page gutter 24 px. Native text and controls, outlined Lucide icons, 8 px panel radius. Main composition: campaign heading, lifecycle, three metrics, map/evidence split, schedule.

Intentional departures from the generated concept: removed the unverified “all systems operational” claim; unavailable video has no play button; example tasks never say “in progress”; competitor examples are named as examples. Added campaign selection and an accessible location list. Real map geography replaces the image-generated map.

## Account release — September 16

The application root now requires verified Supabase authentication. The previous illustrative dashboard is at `/demo`. Customers can create a workspace, save validated campaign drafts to Supabase, switch workspaces, and export drafts. The initial business fields use Stakeout Search and https://stakeoutsearch.com. This is a separate application; the existing marketing homepage and white-label page are unchanged.

`search_campaigns` has RLS. Workspace members can read their organization's drafts; only owners/admins can insert them. Browser roles cannot update status, delete records, or activate campaigns. The API independently verifies the user and workspace role. No service-role key is used by this app.

Deployment: https://stakeout-search-app.vercel.app

Required Supabase Auth URL configuration: add `https://stakeout-search-app.vercel.app/auth/callback` under Authentication → URL Configuration → Redirect URLs. Keep the existing Site URL and existing redirect entries. The current connector cannot read or update this setting, so email-link completion is unverified. No test emails were sent.

Vercel project: `stakeout-search-app` (`prj_xQ6nbBCyCnDbK2IZB7MOxcZtfXwO`). Deployment files include public Supabase configuration in `.env.production`; no privileged credentials are embedded. Configure the two `.env.example` keys in project settings before switching to Git-driven builds. The app is deployed independently and is not connected to the repository's main-branch auto-deploy.

Supersedes the earlier launch-gate description for login code and campaign persistence: these are implemented and the database migration is applied. Email round-trip and authenticated production save still need end-to-end verification. Billing, provisioning, task dispatch, and capture ingestion remain unimplemented in this app.
