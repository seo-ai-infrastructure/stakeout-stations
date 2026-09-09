# Map and automatic inventory update — September 9, 2026

The blank map was missing MapLibre 6 worker assets. The build now publishes its worker and shared module together, preserves marker positioning classes, and shows useful loading/error states. The map preview at `/map-preview` uses sample stations only.

Previously, inventory sync only reconciled stations already registered in Supabase. This release adds automatic metadata discovery through the Railway tenant queue, using the existing provider rate gate. It runs on startup and every 60 seconds, subject to queue load and provider availability. The dashboard reads saved snapshots every 30 seconds. Open **DuoPlus devices** to search discovered phones; expired phones are hidden by default. Choose **Set station location** to register a phone with explicit coordinates. Discovery does not power devices, change locations, or enable ticks.

## Complete the deployment

1. Extract `stakeout-stations-map-inventory-fix.zip`.
2. Open `seo-ai-infrastructure/stakeout-stations` on GitHub, on `main`.
3. At the repository root, use **Add file → Upload files**. Drag the extracted files and folders into that page, preserving their folder structure, and commit.
4. In Railway, open the `stakeout-stations` project and `telemetry-engine` service. Press **Cmd+K** (Ctrl+K on Windows), then choose **Deploy Latest Commit**. A deployment's Restart or Redeploy action reuses its old source.
5. Verify the deployment shows the new GitHub commit and reaches SUCCESS. Refresh the dashboard, then open **DuoPlus devices**. Allow approximately 60–90 seconds for discovery plus dashboard refresh; longer if the provider is busy or rate-limited.

The Supabase migration `20260909020831_fleet_inventory.sql` is already applied to `rgaxccniacasrabfnpsp`. No API keys or auth URLs need changing for this release.

## Verification and limits

Production Next.js and Railway worker builds passed. The inventory, RLS, and map-asset tests passed (21 tests). Hosted inventory grants and RLS were verified. The map worker and its shared module return HTTP 200 with JavaScript content types. The remote QA browser cannot initialize WebGL2, so visual map rendering could not be verified there; its new graphics-error message was verified.

GitHub writes still return `403 Resource not accessible by integration`; the source changes are supplied in this ZIP. The Vercel interface and database changes are published independently. Automatic inventory discovery is pending deployment of the new Railway worker, not merely a restart of the existing worker.

References: [MapLibre 6 migration](https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/), [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions#redeploy).
