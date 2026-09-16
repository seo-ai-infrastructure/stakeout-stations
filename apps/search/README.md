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
