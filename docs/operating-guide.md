# Stakeout Stations: verified operating guide

Audit date: 8 September 2026. Source baseline: GitHub commit `de75e65` in `seo-ai-infrastructure/stakeout-stations`. Production dashboard: https://stakeout-stations.vercel.app.

This guide describes the deployed SaaS and identifies the presentation corrections prepared during this audit. It supersedes the supplied Observatory guide as a description of this project. That document describes a different local controller and several behaviors that are absent here. A requested feature is not evidence that it has been implemented or tested.

> September 9 update: the map worker packaging and marker positioning have been corrected. This release adds a DuoPlus inventory panel and a metadata-only discovery worker. The database migration is installed; automatic discovery requires deploying the updated Railway worker from this release. The September 8 audit observations below are historical.

## 1. What is running

| Component | Actual responsibility |
| --- | --- |
| Vercel / Next.js | Login, workspace dashboard, membership-checked configuration APIs, station registration and controls. |
| Supabase | PostgreSQL records, Auth, tenant RLS, Vault-encrypted credentials and identity baselines, durable job outbox, telemetry history, private Realtime. |
| Railway worker | Processes BullMQ jobs, calls provider APIs, handles retries and device locks, and generates configured coordinate commands. |
| Railway Redis | Queue storage, distributed leases, cached inventory, rate gates, cooldowns and a durable telemetry spool. |

There is no SQLite book and no production dashboard on port 8787. Redis is required, rather than optional plumbing. The Railway service runs one replica. Application locks support ownership fencing, but additional replicas have not been validated as a production scaling configuration.

## 2. Live state verified in this audit

- The worker was enabled and healthy. Its startup verified Redis and Supabase connectivity.
- DuoPlus inventory/connection-test jobs completed successfully. A DuoPlus credential is marked ready.
- One workspace and one live-mode station were registered.
- The station's saved state was OFFLINE, with ticks disabled, no recorded sample and no captured identity baseline.
- No WiGLE credential was configured. The station's Environment Sync job failed with a provider-authentication error. This does not mean its separate DuoPlus key failed.
- The two source migration versions match the hosted migration history. The superseded duplicate migration was removed from GitHub in `de75e65`.

These are observations at the audit time. They do not prove the phone's current physical location, app-visible GPS, radio reception, proxy exit, or account reputation. The saved OFFLINE value is not a fresh independent power observation.

## 3. Operator workflow

1. Sign in and create or select the workspace. The first organization starts with a configurable startup limit of three devices.
2. Add a DuoPlus key in API keys. Test queues a read-only inventory reconciliation. Wait for the job to complete and the key to show ready.
3. Register the intended station explicitly with its DuoPlus image ID and target coordinates. Automatic discovery lists account phones in the DuoPlus devices panel; registering a station still requires target coordinates.
4. Add the workspace's WiGLE credentials if Environment Sync is required. The application requires confirmation of the applicable commercial authorization. A valid DuoPlus key cannot authenticate a WiGLE request.
5. Run Environment Sync from the station inspector after credential setup. Examine the result: synced, partial, no results, or failed. Empty fields stay empty.
6. Use the fleet refresh control after power changes made in the DuoPlus console. It queues inventory reconciliation. The dashboard's normal database refresh is not a provider power poll.
7. Treat Power on, Resume ticks, route controls and RPA dispatch as explicit device actions. The app has these controls; it is not an exclusively passive sidecar.
8. Inspect job outcomes and sample source labels. Verify the actual device or app through independent evidence before describing a requested coordinate as observed location.

No live phone was powered on, moved, or given a new identity during this document audit.

## 4. Clocks and external power changes

The database supervisor runs approximately every 1.2 seconds. The configured coordinate cadence defaults to seven seconds, subject to provider pacing, work backlog and errors. History flushes approximately every 30 seconds. Browser Realtime subscriptions and periodic database refreshes update the interface.

The updated discovery worker reads account inventory on a 60-second schedule through the tenant queue. It saves metadata snapshots for the dashboard and never changes station controls. Manual fleet-sync jobs still reconcile saved station power state. Provider reads made by eligible live operations use an inventory cache lasting up to 60 seconds. OFFLINE stations are excluded from the ordinary coordinate selection query. Consequently, a phone started by an external DuoPlus template is not guaranteed to wake this application automatically.

A 30–45 second template delay is not an implemented readiness guarantee. The software has no OFF-to-ON full-environment bind acknowledgement that such a timer could wait for. Operators should check the real job and device state rather than infer readiness from elapsed time.

## 5. Power status and capacity

DuoPlus distinguishes on, off, starting, configuring, expired and failed states. This app requires confirmed on status for an eligible live coordinate operation; it does not assume that starting status means writable. Missing inventory is unknown, not confirmation that a device is off. See the [official status contract](https://help.duoplus.net/docs/cloud-phone-status).

Power actions query inventory and startup subscriptions before allocating an additional slot. Expired subscriptions do not increase verified capacity. The configured workspace limit is separate from the number of image IDs in inventory.

The dashboard historically counted saved powered flags among registered stations. That count is not a real-time account-wide subscription meter. The audit's UI correction labels it Recorded on / cap and explains the limitation. Recent samples counts stations with a recent sample, rather than treating an enabled switch as proof of current activity.

## 6. What coordinates mean

The existing command model and its route interpolator are implemented, but they do not match all of the supplied guide's numbers. Its stationary boundary is a strict 15 m cap around the stored anchor. Accuracy and altitude are stored/model values; speed and bearing are computed model outputs. The UI must not call them measured handset sensors.

Routes are entered as longitude/latitude points. The app has no OSRM integration or automatic road matching. It has no separate walking/driving routing modes and no documented eight-second late-tick rule. Arrival advances the anchor and queues a new environment revision. Park clears the route and uses the current anchor; it does not preserve a separate original-home destination for a later return trip.

The audit's map correction draws the 15 m model boundary around the saved anchor. Previously the rendered ring used the accuracy field around the moving coordinate. Neither ring represents a legal area, an S2 cell outline, or evidence of current GPS uncertainty on the phone.

## 7. Environment Sync and identity

Registration, relocation, route arrival, manual refresh, and enabled monthly maintenance can create environment jobs. The worker queries WiGLE separately from the coordinate loop, retains raw observations in tenant-scoped snapshots, and reuses eligible cached results for up to 30 days. Retries can reuse completed endpoint results. This reduces quota consumption; it is not an unconditional once-per-campaign guarantee.

The current selector uses the nearest valid returned observations inside the configured geographic radius. It does not classify home versus campus buildings, resolve proxy IPs, map ISPs to carriers, widen the radius automatically, or manufacture fallback APs. The application does not know present signal strength from a historical WiGLE record.

Relocation deliberately invalidates the old environment revision and clears its cached device fields before a new lookup. This differs from the supplied guide's rule that a radio lock survives any new pin. Manual refresh and monthly maintenance also mean the saved environment is not an immutable campaign identity.

Existing provider-assigned hardware/SIM values are captured into an encrypted baseline when an identity check runs. Later reads can detect drift. The baseline is never generated or replayed as routine configuration, and an application snapshot cannot prevent changes made in the provider console.

There is no generated IMSI/ICCID pair, Bluetooth identity, APN lock, locale-from-proxy setup, proxy ASN monitor or PROXY incident badge. No ISP-to-mobile-carrier inference is treated as verified handset evidence.

## 8. Provider writes and evidence limits

Routine command payloads currently include GPS coordinates and, when populated, cached Wi-Fi identifiers and SIM network codes. They are not GPS-only writes following one full environment write at wake. The implementation does not inject Bluetooth, APN, timezone, language or tower identifiers during this flow.

The documented GPS update fields do not include speed, bearing, altitude or accuracy. Update acceptance is tracked per device, not inferred from an HTTP success alone. The [official update contract](https://help.duoplus.net/docs/Batch-Modify-Parameters) does not prove Android FLP behavior or evasion of fraud checks.

History distinguishes simulated samples from provider-accepted commands. It is not a capture system for device-observed GPS, UI XML, screenshots or video. Those artifacts require a separate observation workflow. An accepted command does not establish what Chrome, Maps or another application actually received.

## 9. Throughput and durability

Compatible device requests are grouped by tenant and credential, with a conservative batch cap of 20. The default request gate serializes each workspace's DuoPlus calls at least 1.2 seconds apart. Adding credentials does not multiply assumed throughput. The [official introduction](https://help.duoplus.net/docs/Introduction) states an interface rate limit without proving independent allowances for each key.

This is not a guaranteed 140-device service level, and there is no implemented two-imports-per-pulse budget because automatic discovery lists metadata while station registration remains explicit. A dark fleet produces no per-device coordinate commands, but the database supervisor and queue infrastructure remain active.

Control jobs originate in a PostgreSQL outbox. Redis queues and leases coordinate work. Failed history writes retain a spool for replay, with event IDs preventing duplicate history inserts. These mechanisms were tested; comprehensive live restart/failure recovery on a real device fleet remains unverified. The database uses regular indexed tables, not a Timescale hypertable. A retention setting exists, but automated history deletion is not implemented.

## 10. Comparison with the supplied guide

| Claim or workflow | Audit result |
| --- | --- |
| Local SQLite book and localhost dashboard | Different: hosted Supabase and Vercel. |
| Redis optional | Different: required by the worker. |
| Read-only controller with externally owned power/RPA | Different: this app also offers power and RPA actions. |
| Provider fleet pulse every 20 seconds | This release adds a 60-second metadata discovery schedule; it does not automatically wake station controls. |
| Automatic import, two new phones per pulse | Account devices are discovered automatically after worker deployment. Station location assignment remains explicit. |
| Read proxy IP, ASN, ISP, city and timezone | Missing. |
| ISP-specific Wi-Fi/carrier selection | Missing; inferred identity is not verified evidence. |
| Generate and freeze SIM/APN/Bluetooth | Not implemented; provider-assigned identities are preserved. |
| Full environment bind only on wake | Missing. No such rising-edge state machine. |
| Booting status treated as writable | Different: live operations require on status. |
| Seven-second coordinate cadence | Implemented as a configurable target, not a deadline guarantee. |
| WiGLE outside each coordinate tick | Implemented. Cache/refresh rules differ from the guide. |
| Fifteen-meter stationary boundary | Implemented; UI ring correction prepared in this audit. |
| Consumer sensor values delivered to handset | Unsupported claim; several values are model-only. |
| OSRM routes and walk/drive modes | Missing. Manual route interpolation exists. |
| Radio values unchanged on relocation | Different: a new location revision is provisioned. |
| Proxy-change alerts | Missing. |
| Restart-persistent secrets and locks | Implemented through hosted storage and Redis, not SQLite. |
| Private workspace isolation and encrypted BYOK | Implemented and tested against hosted Supabase. |
| Actual app-location evidence | Missing from this product. Command acceptance is recorded. |

## 11. Improvements prepared by this audit

The code changes add an explicit no-sample/last-sample message, identify missing WiGLE setup, explain saved power state, prevent the inspector from queuing an environment refresh without usable WiGLE metadata, label modeled accuracy in exports/tables, and render the model boundary at its actual anchor. They do not introduce automatic device actions or fabricated identities.

Publication and validation status must be checked in the handoff for this audit. The original guide is not a valid assertion that the missing behaviors exist. Future observability work should prioritize verified provider power status, independent device evidence, clear provenance and explicit readiness acknowledgement.

## 12. Publication and validation handoff

The dashboard corrections were deployed to production as Vercel deployment `dpl_8Jba9NB384cAVdggRjXYS2ftxgsM`, which reached READY and owns the `stakeout-stations.vercel.app` alias. The production build and TypeScript checks passed. Browser visual/interaction verification could not run because this environment lacked a browser and its download timed out.

GitHub still rejected the source write with `403: Resource not accessible by integration`. The accompanying source ZIP contains the changes for the existing repository. It contains no environment file or provider credentials. Until those files are committed, a Git-based deployment can omit these corrections. No worker execution or database schema changes were made in this audit.
