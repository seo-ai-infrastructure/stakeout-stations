# DuoMove Drive

A working route planner, authenticated Railway control service, and Android player for controlled DuoPlus drive simulations. The controller uploads a complete timed route once. The phone owns its 1 Hz playback clock; ADB transports commands over a persistent forwarded socket.

This is a **synthetic location testing system**. It uses Android's supported test providers and Google Play services mock-location delivery, retaining mock flags. It does not manufacture physical motion, hide instrumentation, inject fitness records, change account trust, or guarantee Google Maps accepts a session.

## Included behavior

- Distance-conserving traversal across short geometry segments and longitude wrap.
- Forward/backward speed planning, bounded acceleration/braking, explicit stops and arrival dwell.
- Rounded corners with a configurable envelope and lateral-acceleration speed cap. Geometry is a road-route approximation, not lane truth. Set `--corner-cut 0` to preserve the raw polyline; heading discontinuities then require stopping.
- Complete `Location` samples: latitude, longitude, speed, travel bearing, accuracy, optional WGS84 ellipsoid altitude, wall time and device-boot-relative elapsed time.
- SHA-256 checked, resumable uploads; idempotent start; one active route per player.
- A 15-second control lease. Disconnects can recover within that lease; expired sessions cannot resume automatically.
- Device process restart detection; controller restart marks unfinished jobs interrupted. Neither restarts movement.
- Persistent provider ownership journal: reopening the player cleans up providers left by a killed process before accepting commands. While the process is dead it emits no further locations; cleanup cannot execute until it runs again.
- Skipped-sample/lateness metrics; no rapid catch-up burst. A substantial scheduler stall fails the run.
- Provider acknowledgements and separate callback readback counters **inside the player app**. These do not prove what Maps, Chrome, or another app observed.
- SQLite run journal, private HTTP authentication, configured device aliases, and a configurable concurrency cap.

## Why a new APK

The existing `site_fix` v0.2 source is a checker-only getter overlay. Its file transport, schema, and scope cannot deliver a route to Android location subscribers. This player is a separate ordinary Android APK; it is installed with `adb install`, **not** `dplus install`. The old getter module is not required. Do not run another location writer on the same phone during playback.

## Build and test

Python 3.12+, JDK 21, Android SDK Platform 34 / Build Tools 34.0.0, and ADB are required. The checked-in Gradle wrapper pins Gradle 8.7 and verifies the distribution checksum. The Android project is Java-only and needs no vendor bridge or NDK.

```bash
cd services/duomove-drive
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.lock
pip install -e '.[test]'
pytest -q
node --test integration/controller-client.test.mjs
cd android
./gradlew --no-daemon :core:engineTest :player:assembleDebug :player:lintDebug
```

APK: `android/player/build/outputs/apk/debug/player-debug.apk`.

The debug build permits private token provisioning through `run-as`. Use this build only on your controlled test phones. A release build needs your signing/provisioning workflow; its token cannot be installed using debug-only `run-as`.

## Prepare one DuoPlus phone

Enable DuoPlus ADB and allowlist the controller's outbound IPs. Power the selected phone on through your existing scheduler. Identify its exact current ADB endpoint. This service does not power devices on or bypass subscription limits.

Run from `services/duomove-drive` after installing the Python package:

```bash
duomove-drive provision \
  --serial "$DEVICE_SERIAL" --connect \
  --apk android/player/build/outputs/apk/debug/player-debug.apk \
  --token-file player.token

duomove-drive status \
  --serial "$DEVICE_SERIAL" --connect --token-file player.token
```

Provisioning installs the APK, grants foreground location permissions, authorizes its mock-location app-op, and opens the player. The token is generated locally with mode 0600 and written to the app's private directory through stdin. It is never sent as a shell argument or stored on shared storage. Keep it out of Git and browser code.

The phone must display **Ready**. Check `status` successfully authenticates before starting a route. If the image refuses the app-op, permissions, foreground service or test providers, resolve that device capability issue first; the engine reports failure instead of silently using a partial fallback. With available Google Play services, fused delivery must initialize successfully. Without it, status explicitly reports framework-only delivery.

## Prepare and run a route

Existing routing providers can export a GeoJSON LineString. GeoJSON uses `[longitude, latitude]`; the HTTP planner's `coordinates` use `[latitude, longitude]`.

```bash
duomove-drive plan --geojson route.geojson \
  --mph 32 --acceleration 1.5 --braking 2 \
  --stop 350:10 --arrival-dwell 30 --out drive-plan.json
```

Stop distances are measured along the resulting rounded route. Stops are explicit scenario inputs, not inferred live traffic lights. Omit `--stop` when no stop is intended.

An explicit OSRM endpoint is also supported:

```bash
duomove-drive plan \
  --start 28.039465,-81.949804 --end 28.065120,-81.982340 \
  --osrm https://YOUR-ROUTING-SERVER \
  --mph 32 --arrival-dwell 30 --out drive-plan.json

duomove-drive run --serial "$DEVICE_SERIAL" --connect \
  --token-file player.token --plan drive-plan.json --report drive-result.json
```

Use your contracted/self-hosted routing endpoint for production. Route fetching is bounded and retries only transient failures. No routing request is made per playback tick. Accuracy is a configurable test uncertainty, not derived from speed or DOP; altitude is absent unless explicitly supplied.

Ctrl+C or SIGTERM requests cancellation. The phone lease is the fallback when the connection is unavailable. Closing a socket alone does not stop a drive immediately; it permits bounded reconnection. The player's **Stop drive** button cancels locally.

## Railway deployment

Create a separate service sourced from this repository/branch:

| Setting | Value |
| --- | --- |
| Root directory | `/services/duomove-drive` |
| Config file | `/services/duomove-drive/railway.toml` |
| Dockerfile | `Dockerfile`, relative to the service root |
| Replicas | `1` |
| Persistent volume | `/data`, writable by UID 10001 |
| Health check | `/healthz` |
| Sleep/serverless | Disabled |
| Networking | Private service networking |

Set these variables through Railway, not Git:

```text
DUOMOVE_INTERNAL_TOKEN=<random server-to-server secret, at least 32 characters>
DUOMOVE_TARGETS_JSON={"phone-alias":{"serial":"HOST:PORT","token":"PER_PHONE_TOKEN","connect":true}}
DUOMOVE_CAPACITY=3
DUOMOVE_STATE_DIR=/data/duomove
```

Use the actual provisioned `player.token` value for each configured phone. `/healthz` reports process health, not phone readiness. No drive starts on service boot. The ADB daemon belongs to this worker; every command is pinned to its configured serial. Each route receives an automatically allocated host forward port, so multiple phones can use device port 9999 simultaneously.

The HTTP listener supports IPv4 and IPv6 together. Call it from a worker in the same Railway environment; Vercel browser/server code cannot directly resolve Railway private service names.

API:

| Method / path | Behavior |
| --- | --- |
| `GET /healthz` | Process health; unauthenticated |
| `GET /v1/targets` | Configured aliases and concurrency capacity |
| `POST /v1/plans` | Plan from coordinates and motion settings; no phone writes |
| `POST /v1/runs` | `{run_id: UUID, target: alias, plan: object}`; start an authorized drive |
| `GET /v1/runs/{run_id}` | Durable progress and delivery/readback evidence |
| `POST /v1/runs/{run_id}/cancel` | Request cancellation |

All `/v1` endpoints require `Authorization: Bearer <DUOMOVE_INTERNAL_TOKEN>`. Generate and retain a run UUID before submitting. Repeating the same run ID/target/plan returns its existing record; conflicting reuse is rejected. A different run on an occupied device returns 409.

## Existing Observatory controller integration

This is a **trusted server-to-server service**, not a browser-facing multi-tenant authorization boundary. Your Vercel/worker layer must authorize membership and target ownership before calling it. Keep both control tokens server-side.

For each drive, your scheduler must:

1. Acquire its existing distributed device lease and a powered-device slot.
2. Pause that device's existing REST/idle telemetry (`ticks_enabled=false`) and any competing route writer; drain any in-flight update before proceeding.
3. Submit the prepared route using a durable UUID and configured phone alias.
4. Poll the run record while renewing the scheduler lease. Do not power the phone off during an active run.
5. Release the slot only after terminal state and provider cleanup. If cancellation/connection is uncertain, hold the device until the phone lease has expired and verify status.
6. Restore the prior telemetry setting only if the same control version still owns the device; do not overwrite a user's newer pause or relocation.

The current repository checkout imports missing worker modules (`telemetry`, `providers`, `fleet`, and others). This change does not claim to repair or deploy that incomplete application. The standalone service and adapter are independently buildable; wiring it into the existing worker requires the actual complete worker source. See `integration/controller-client.mjs` for the callable control contract.

```js
import { DriveClient, safeToRelease } from './integration/controller-client.mjs';
const drive = new DriveClient({ origin: process.env.DRIVE_ORIGIN, token: process.env.DRIVE_TOKEN });
// After authorization, ownership acquisition and telemetry drain:
await drive.start({ runId: persistedJobUuid, target: configuredPhoneAlias, plan });
const result = await drive.wait(persistedJobUuid, { signal, onProgress: renewDeviceLease });
// Only restore telemetry/release ownership if safeToRelease(result) is true.
// Otherwise reconcile phone status while retaining ownership.
```

Keep the UUID and route with your durable job. A wait failure requests cancellation but does not establish that cleanup finished. The adapter deliberately leaves ownership/restoration to the scheduler that acquired it.

## Verification limits

`applied_seq` means provider write calls completed. `framework_observed_seq` and `fused_observed_seq` advance only when this player's callback matches the tagged sample's coordinates, fields, timestamps and mock marker. Readback may lag or be unavailable; it never substitutes for a target-app observation.

Physical phone acceptance remains a separate check: install on one DuoPlus image; run a short route with acceleration, a turn, a stop and dwell; inspect the player and target app; interrupt the ADB connection; confirm lease expiry and cleanup. Repeat for the Android images/app versions you support. Android scheduling is not hard real time, and 1 Hz is a target with measured lateness, not a guaranteed ±5 ms claim.

References: [DuoPlus ADB](https://help.duoplus.net/docs/adb), [Android Location](https://developer.android.com/reference/android/location/Location), [Fused location mock delivery](https://developers.google.com/android/reference/com/google/android/gms/location/FusedLocationProviderClient), [Foreground location service](https://developer.android.com/develop/background-work/services/fgs/service-types#location).
