# Stakeout Command

DuoPlus RPA scheduling across a limited pool of subscription startup slots.

## What is built

- React/TypeScript application for Vercel: Command Center, devices, custom templates, schedules, run history, CSV export, and settings.
- A clearly labeled, browser-local demo: ten Android devices, three slots, fifty task runs. Demo jobs finish in 20–36 seconds.
- Supabase authentication and six tenant-isolated tables. Each signed-in user owns one workspace; team invitations and billing are not included in this release.
- Encrypted DuoPlus keys in Supabase Vault, readable only by the Railway worker. The browser receives no server key or decrypted provider key.
- Daily, weekly, and one-time schedules, date ranges, daily start times, timezones, ordered templates, per-device variable substitution, and input snapshots.
- A Railway worker with paginated device/template discovery, subscription verification, durable jobs, transactional capacity claims, account leases, provider task-log monitoring, and confirmed shutdown before releasing a slot.

## Deployment

Source lives in the `command/` directory on the `feat/command-daily-drain` branch of `seo-ai-infrastructure/stakeout-stations`. The existing Stations application is a separate application.

- Supabase project: `rgaxccniacasrabfnpsp`. Both versioned migrations in `supabase/migrations` are applied. For a new project, apply both in order.
- Railway service: `command-scheduler`, root `/command`, branch `feat/command-daily-drain`, Dockerfile.worker. Set SUPABASE_URL and SUPABASE_SECRET_KEY server-side; port 8080; health /health. Check `docs/deployment-status.json` for verified deployment state.
- Vercel: deploy the `command/` directory as a Vite project, build `npm run build`, output `dist`. Frontend environment values are in `.env.production` and are public configuration only.

## Use it

1. Sign in, then open Settings and connect your DuoPlus API key. Discovery does not power devices on.
2. Assign and enable devices. Review the inputs for imported custom templates.
3. On each device, choose **Daily tasks**, select its ordered template list and inputs, and choose a daily start time. Different devices can have different lists. You can also assign one schedule to several devices.
4. Confirm the DuoPlus scheduling timezone and exclusive account control, then resume dispatch. A separate controller must not independently power the same account's phones.
5. Command fills available slots, monitors real task outcomes, keeps each phone on for its list, then confirms shutdown and rotates in the next phone. DuoPlus scheduled-task submission uses a short future publish time; it is not a subsecond trigger.
6. Inspect Needs attention for failures, uncertain provider results, and overdue work. Failed tasks require an explicit retry after confirmed shutdown. No successful daily completion is claimed for failed tasks.

Same-day completion depends on total work fitting within available slot-hours and provider availability. Unfinished persisted work carries forward. Add the verified production URL to Supabase Auth's redirect allowlist for signup confirmation.

## Local development

Node 22 or newer:

```sh
npm ci
cp .env.production .env.local
npm run dev
npm test
npm run build
```

To run the worker, set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the environment, then `npm run worker`. `WORKER_ENABLED=false` starts only the health endpoint. The app works in demo mode without any credentials.

## Scheduling behavior

- Device inventory and startup subscription capacity are discovered through DuoPlus and refreshed automatically. Live capacity cannot be manually overridden.
- All observed on/starting/configuring phones consume capacity, including manually powered phones. Unknown power states block new claims.
- Job reservations persist through startup, task submission, running, shutdown, and uncertain/attention states.
- A phone retains its slot while its due task list runs. After the last task, confirmed `powered off` frees the slot. A power API acknowledgment, expiry, or missing inventory is insufficient.
- Work is ordered by deadline, then schedule priority, then task position. Only one job may be active per phone. Confirmed task completion starts the next due task on that phone. Estimated minutes never trigger completion.
- Pausing dispatch stops new claims and lets existing claims finish. Pausing a schedule cancels its queued jobs. Resuming does not recreate cancelled occurrences; a new schedule can be used when the same day's work must be re-created.
- Existing queued runs retain snapshots when a schedule or template changes. Changes affect future, not-yet-materialized occurrences.
- Occurrences for today and tomorrow are persisted. If the worker is offline beyond that horizon, earlier unmaterialized days are not retroactively generated. Persisted overdue jobs remain queued until processed and appear in Needs attention.
- Nonexistent daylight-saving times fail validation/materialization rather than silently moving the schedule. Ambiguous fall-back times use the conversion's first converged occurrence; daily queues may continue after midnight.
- Estimates are based on configured template durations. They are not live per-step RPA progress.
- Failed task retries require a confirmed terminal failure and a powered-off device. A timed-out submission is never blindly reissued: its unique provider name is reconciled against task logs. Attention states may need intervention in DuoPlus; no force-release UI is provided.
- API requests are serialized with a 1.25-second minimum interval for each workspace. One persisted workspace lease prevents competing worker processes from dispatching for the same workspace.
- One workspace should represent one DuoPlus account. An exact API-key fingerprint cannot be registered twice. Different API keys for the same provider account cannot be automatically identified as one account from the documented endpoints.

## Template inputs

The provider template-list API returns metadata, not a complete input schema. Synced templates start with **Review inputs** status. Import a JSON export or add input definitions manually, then confirm them. JSON import extracts recognized `key`, `type`, `required`, and string `value` definitions; it does not upload or rewrite the workflow in DuoPlus.

Supported variable references: `{{device.name}}`, `{{device.city}}`, `{{device.latitude}}`, `{{device.longitude}}`, and `{{client.name}}`. File inputs accept newline-separated provider file IDs or URLs. GPS fields store the assigned reference location; this release does not change device GPS.

## Verification and limits

- `npm run build`: passed.
- `npm test`: 16 tests passed, including 20/3, 50/5 and 100/3 device/slot combinations, zero capacity, same-phone continuation, and all fifty demo jobs completing at maximum three slots, serialized-state restarts, pause/drain, capacity reduction, expired devices, timezone/DST, snapshot isolation, and provider envelope errors.
- `database/verify.sql`: passed against hosted Supabase with all fixtures rolled back. Checks capacity claims, shutdown reservations, worker leases, capacity reduction, RLS isolation, Vault, and browser privileges.
- Database security advisors: no new warning for Command tables/functions. Private credential/lease tables intentionally have RLS and no client policies. The project has an existing leaked-password-protection warning; enable it in Auth when appropriate: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection.
- No real phone was powered on or used for an RPA acceptance run. The Railway worker must be deployed before those checks are possible.
- Browser visual verification was blocked: the managed browser could not reach the local preview; returned hosted URLs required Vercel sign-in; the local Chromium download failed. Visual fidelity and mobile interaction are not marked verified.
- Dashboard history is capped at the latest 1,000 jobs within 30 days; coverage is derived from that loaded window plus all unfinished jobs, which are paginated independently. No screenshots/video evidence capture, billing, team sharing, advanced cycle presets, calendar timeline, or automated duration learning is included.

## Provider references

- https://help.duoplus.net/docs/Introduction
- https://help.duoplus.net/docs/cloud-phone-status
- https://help.duoplus.net/docs/Custom-Template-List
- https://help.duoplus.net/docs/Create-Scheduled-Task
- https://help.duoplus.net/docs/scheduled-task-list
