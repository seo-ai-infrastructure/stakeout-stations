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
