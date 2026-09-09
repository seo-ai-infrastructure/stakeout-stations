# Deployment runbook

## Current status

- Canonical source: https://github.com/seo-ai-infrastructure/stakeout-stations (`main`). Railway source metadata confirms this owner and branch. The GitHub integration rejected writes with HTTP 403, so the hosted SQL fixes and updated runbooks still need to be committed from the supplied patch or an integration with repository write access.
- Vercel is serving https://stakeout-stations.vercel.app with Supabase authentication enabled. An unauthenticated dashboard request returns 401.
- Supabase project `rgaxccniacasrabfnpsp` is active. Both migrations are applied; hosted tenant isolation, Vault encryption/decryption, worker tenant binding and provisioning-outbox tests pass. Temporary fixtures were rolled back. Security advisors contain only two expected informational notices for private tables with no browser policies.
- Railway Redis and the worker container have deployed successfully. The engine remains disabled pending live integration verification. Railway now defines SUPABASE_SECRET_KEY; its value has not been inspected.
- Desktop/mobile controls were verified. The QA network blocked Carto style requests, so full map rendering remains unverified.

The user confirms Auth Site URL `https://stakeout-stations.vercel.app` and redirect `https://stakeout-stations.vercel.app/auth/callback` are configured. Railway variable names now include `SUPABASE_SECRET_KEY`. Before activation, verify actual email login, authenticated worker connectivity, and tenant BYOK keys in Key Manager. The server key stays in Railway variables.

## Vercel

This deployment includes the two public Supabase values in a deployment-only `.env.production`. Before switching to Git-driven Vercel deployments, save those same public values in Vercel project environment variables.

The root is a Next.js project. Install with `npm ci`, build with `npm run build`. Node.js 22+ is required. The worker folder is not executed by Vercel.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the appropriate Vercel environments. Both are public project identifiers, not privileged keys. The web app uses the authenticated user's session for configuration APIs and Vault-store RPCs.

## Supabase

The dedicated project is `rgaxccniacasrabfnpsp`; its migrations are already applied. The local migration filenames match the hosted migration history. For another environment, apply both files under `supabase/migrations`. Hosted Vault internal function ACLs are managed by Supabase; the migration confines browser access at the schema/table boundary.

In Auth, configure the deployed app as Site URL and allow its `/auth/callback` redirect. Configure production SMTP for customer login delivery. Disable public Realtime access; the application uses private channels. Run Supabase security advisors after the migration, then perform an authenticated two-tenant smoke test.

The worker needs `SUPABASE_URL` and a server-side `SUPABASE_SECRET_KEY`. This privileged key is set only on the Railway worker. Customers enter their separate DuoPlus/WiGLE keys through the app.

## Railway

The `stakeout-stations` project and `telemetry-engine` service have been created. The worker service uses `Dockerfile.worker`, stays awake, restarts on failure, and checks `/health` on port 8080.

The worker source repository is `seo-ai-infrastructure/stakeout-stations`, branch `main`. The existing service uses `Dockerfile.worker`.

For a locally authenticated CLI, inspect current command help first, link this source folder to the created project and existing engine service, and deploy with `railway up`. The Dockerfile is the build source of truth.

| Worker variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Dedicated Supabase API URL |
| `SUPABASE_SECRET_KEY` | Privileged server-side Supabase access; never public |
| `REDIS_URL` | Railway private Redis reference with authentication |
| `ENGINE_ENABLED` | `false` until live configuration and credentials are ready |
| `PORT` | `8080` for health checks |
| `NODE_ENV` | `production` |

Redis must have a persistent `/data` volume, AOF persistence (`appendfsync everysec`), `maxmemory-policy noeviction`, and a password. Do not expose Redis through a public endpoint. Retain enough memory for queues and telemetry backlog; persistence is not a substitute for independent backups.

## Connect the worker source in Railway

1. Use `seo-ai-infrastructure/stakeout-stations`, branch `main`. `package.json`, `railway.toml`, and `Dockerfile.worker` are at the repository root.
2. Open the existing Railway `stakeout-stations` project and select the existing `telemetry-engine` service.
3. Select **Settings → Service Source → Connect Repo**, choose the source repository, and select its `main` branch.
4. If the repository is missing, configure the Railway GitHub App to grant access to that repository: https://github.com/apps/railway-app/installations/new
5. Keep Root Directory `/`, Dockerfile Path `Dockerfile.worker`, and `ENGINE_ENABLED=false` until Supabase and provider credentials are configured. The Dockerfile supplies the worker start command.
6. Apply the staged changes using Deploy, then check the build and `/health` readiness. Initial execution remains disabled.

Official source-connection documentation: https://docs.railway.com/services#deploying-from-a-github-repo

## Release verification

1. Run type checks, unit/security tests, and production builds.
2. Apply schema to the chosen new Supabase project; run advisors and verify tenant A cannot read or mutate tenant B's data or decrypt secrets.
3. Verify login, create the first organization, and add customer BYOK credentials through Key Manager.
4. Connect the worker source, set server credentials, and verify Redis and Supabase readiness.
5. Register one station, complete Environment Sync, and verify real provider response semantics before enabling a fleet.
6. Verify pause, relocation fencing, quota cooldowns, process restart recovery, and actual device state. Only then enable the engine for normal operation.
