# Stakeout Stations

A multi-tenant station console for DuoPlus, with a Next.js dashboard, Supabase Auth/Postgres/Vault/Realtime, and a persistent Railway/BullMQ worker. WiGLE Environment Sync provisions a cached geographic reference separately from telemetry.

For the audited operator workflow and differences from the supplied Observatory guide, see [operating-guide.md](docs/operating-guide.md).

## Runtime boundaries

| Component | Responsibility |
| --- | --- |
| Vercel | Next.js App Router, session validation, org-scoped configuration APIs, dashboard |
| Supabase | Membership authorization, RLS, encrypted BYOK credentials, durable job outbox, telemetry history, private broadcasts |
| Railway engine | Device control, physics, tenant queues, rate gates, retry handling, environment provisioning |
| Railway Redis | BullMQ jobs, distributed locks, cooldowns, telemetry spool; persistent AOF and noeviction |

The default organization capacity is **3 concurrent powered devices**, adjustable in Settings. Adding credentials does not automatically increase the configured DuoPlus request rate.

Telemetry requests batch compatible devices from the same organization and credential. The update documentation mentions 20 phones, so the engine caps batches at 20 and handles each device's success or failure independently. A seven-second cadence is a target subject to subscription capacity, queue load, provider latency, and retries; it is not a guaranteed 140-device capacity claim.

## Run and verify

Requires Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run worker:build
npm start
```

With no Supabase public configuration, the dashboard opens a clearly labeled demonstration. Demo changes remain local and no provider credentials are accepted. To use tenant data, set the two public Supabase values in `.env.example`, apply both migrations in order, and configure Auth redirect URLs. Real provider credentials are entered in the authenticated Key Manager; never place tenant keys in Vercel environment variables.

## Automatic device discovery and map setup

The Railway worker reads DuoPlus inventory on startup and every 60 seconds through the tenant queue and shared rate gate. The dashboard refreshes saved snapshots every 30 seconds. Open **DuoPlus devices** to see the account inventory, search phones, or set a station location. Expired devices are hidden by default. Discovery never powers phones on, changes GPS, or starts telemetry; it stores only device ID, name, status, and expiry. Coordinates must be assigned before an unregistered phone has a station pin.

Apply `20260909020831_fleet_inventory.sql` before deploying this release. Existing deployments need the updated Railway worker; restarting an older deployment does not install these changes.

MapLibre 6 requires a separate worker module. `npm run dev` and `npm run build` copy the pinned worker to `public/maplibre/`; do not remove the lifecycle scripts. `/map-preview` displays sample stations without tenant data for browser checks.

## Environment Sync

Registration and relocation create a durable environment-sync request. The worker obtains that organization's WiGLE credentials from Vault, queries the Wi-Fi and cellular endpoints, chooses nearby recorded infrastructure, and stores a location-versioned snapshot. The telemetry path reads the cache; it never calls WiGLE.

- Bounds use a distance in meters and account for latitude and longitude wrap.
- No results stay null. Missing APs or carriers are never replaced with invented values.
- A moved station invalidates its old location version; stale jobs cannot overwrite its current environment.
- The closest recorded AP is a geographic reference, not proof of present reception or strongest signal.
- HTTP or envelope 429 responses create a cooldown. WiGLE uses a one-day default when Retry-After is absent. An insufficient-balance response currently fails the job; it is not treated as a successful lookup.
- Monthly refresh is opt-in. Cached snapshots remain stable until relocation or an explicit refresh.
- WiGLE permission for commercial use is required before enabling its integration. Ordinary individual credentials alone do not establish that permission.

## Location and telemetry semantics

Station coordinates and S2 identifiers describe the intended reference location. A bounded random walk and route interpolation generate requested movement. The dashboard distinguishes simulation from commands accepted by the provider. The documented DuoPlus update API supports GPS coordinates, Wi-Fi identity, SIM network identifiers, and GSM station identifiers; it does not document setting sensor accuracy, altitude, bearing, speed, or RSSI in that request. Acceptance does not prove that an app on the phone observes the requested values.

The model stores telemetry in indexed PostgreSQL tables. It does **not** assume that TimescaleDB/hypertables are available in hosted Supabase.

## Identity stability

The worker captures provider-assigned device/SIM identifiers when a fleet-sync or eligible live operation requests an identity check, encrypts the first baseline, and compares later reads. Registering an offline station alone does not establish its identity baseline. The dashboard exposes only lock status and changed field names. Missing fields in a partial provider response remain unknown; they do not become invented identifiers or automatically count as changes.

Hardware and subscriber identifiers are never included in routine location-update payloads. This matters because DuoPlus documents that writing a nonempty `gsf_id` on Android 10/11 can regenerate it. A random identifier passing a length or checksum test is not evidence of an assigned IMEI, subscription, or telephone number. This application does not fabricate subscriber identities, and does not claim that location updates bypass Android mock-location detection or establish account trust.

## Security model

All customer tables have RLS. Organization membership is checked server-side; members cannot promote themselves or move rows between tenants. Composite foreign keys keep devices, jobs, templates, and history in the same organization. Credential rows exposed to the browser contain metadata only. Vault references and decrypted secrets are accessible only through constrained RPCs. Tenant secrets are never put in BullMQ payloads or log messages.

Telemetry broadcasts use private topics of the form `org:<organization-id>:telemetry`. Subscribe authorization uses membership policies on `realtime.messages`. Public Realtime access should be disabled in the hosted project's Realtime settings. Auth uses PKCE and server-side user validation.

## Deploy

See [deployment.md](docs/deployment.md) for the exact service configuration and current prerequisites. `docs/deployment-status.json`, when present, records created resources without credentials. Never commit `.env` files.
