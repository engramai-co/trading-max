# Repository layout and ownership

Use this map when placing a change. The [system overview](system-overview.md)
describes runtime behavior; this page describes source ownership. Generated
outputs, runtime data and operational evidence are separate from source code.

## Source roots

| Path | Responsibility | Keep out |
|---|---|---|
| `apps/web/app/` | Next.js routes, stable page shells and browser-facing API proxies | Financial formulas and provider credentials |
| `apps/web/workspace/` | Portfolio/research views, chart presentation and view-specific helpers | Broker ingestion and persisted source records |
| `apps/web/lib/portfolio/` | Shared history selection, money calculations, display sampling and chart/detail preparation | React, network requests, server-only adapters and workspace components |
| `apps/web/lib/` | Typed transport, query hooks, server adapters and shared non-view utilities | Route layouts and provider-side financial reconstruction |
| `apps/web/ui/` | Theme, formatting and shared chart lifecycle | Page-specific fetching and accounting rules |
| `services/api/trading_max_api/routes/` | HTTP validation, authorization and request orchestration | Long-running broker/provider work |
| `services/api/trading_max_api/projections/` | Pure NAV, broker and research artifact conversion shared by readers | HTTP routes, storage access and imports from dashboard orchestration |
| `services/api/trading_max_api/` | Typed API projections, artifact readers, settings and job control | Browser presentation logic |
| `backend/src/trading_max/domain/` | Domain contracts | Network and UI dependencies |
| `backend/src/trading_max/application/` | Pipeline stages and use-case orchestration | HTTP route contracts and UI components |
| `backend/src/trading_max/analytics/` | Financial calculations and historical reconstruction | Presentation sampling and chart labels |
| `backend/src/trading_max/ingestion/` | Broker ingestion and import normalization | Generated dashboard state |
| `backend/src/trading_max/research/` and `reference/` | Company/market research and security identity | Real account fixtures |
| `backend/src/trading_max/infrastructure/` | SQLite, immutable artifacts, chunks, packs and snapshots | Financial policy decisions |
| `backend/src/trading_max/worker/` | Durable pipeline execution | Browser request handling |
| `backend/src/trading_max/*.py` | Installed CLI, onboarding and operator services such as backup/retention | One-off audit scripts |
| `backend/migrations/` | Ordered business-database migrations | Derived cache migrations masquerading as business state |
| `tools/` | Repository checks, generators and thin operator entry points | Duplicate implementations of installed services |
| `deploy/local/` and `deploy/macos/` | Foreground local setup and managed macOS releases | Live application state and secrets |
| `contracts/` | Generated HTTP schema | Handwritten parallel endpoint contracts |
| `docs/` | User guides, architecture contracts and operator procedures | Private measurements, credentials or account reports |

The API projects existing financial results; it does not independently invent a
second accounting method. Pure shared calculations should have an explicit
module boundary, with both server and client consumers importing that boundary.
Keep UI components out of server calculation dependencies. Prefer a cohesive
extraction with preserved callers over moving unrelated files merely to shorten
a directory listing.

## Generated and local files

| File or directory | Source / handling |
|---|---|
| `contracts/openapi.json` | Generate with `uv run python tools/generate_openapi.py` from API response models |
| `apps/web/lib/api-schema.ts` | Generate with `npm --prefix apps/web run generate:api-types` from OpenAPI |
| `uv.lock`, `apps/web/package-lock.json` | Commit reproducible dependency locks; retain unrelated resolved versions during a version bump |
| `.venv/`, `node_modules/`, `.next/` | Local dependency/build outputs; ignored, never application state |
| Playwright reports and test results | Generated test evidence; ignored, never authored UI source |
| Snapshot manifests, artifacts, broker exports and saved research | External application state root; never commit real records |
| Credentials | OS credential manager and the supported private bootstrap boundary; never fixture values or documentation |

A release version appears on multiple generated/package surfaces. Follow
[Contributing](../../CONTRIBUTING.md) and run version consistency checks; do not
update only `VERSION`. Generated schemas should change through their generators.

## Tests and checks

Python tests live in `backend/tests/` and `services/api/tests/`. Frontend unit
tests are colocated with the code they cover; browser tests live in
`apps/web/e2e/`. All account fixtures must be synthetic. A move or extraction
should preserve financial outputs, snapshot pinning, missing-data semantics and
cache limits before adding new behavior.

The [required checks](../../CONTRIBUTING.md#before-submitting-a-change) cover formatting,
tests, generated contracts, frontend architecture, documentation links and
release hygiene. Use `tools/check_documentation.py` after a move and update all
callers and links in the same patch. Do not create a compatibility re-export
unless an actual supported consumer requires it.

## Documentation ownership

- The [README](../../README.md) introduces the product and the first successful
  user journey; it is not the operations runbook.
- [Guides](../README.md#use-trading-max) explain user-visible behavior and numbers.
- Architecture pages describe the current contracts. Decision records preserve
  rationale and link to the current implementation and procedures.
- Installation and operations pages own executable procedures and recovery
  boundaries. Distinguish fresh defaults from an operator's enabled policy.
- Private production measurements and release acceptance receipts remain outside
  Git. Public documentation must not turn one host's result into a universal
  performance or storage guarantee.
