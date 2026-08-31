# API and contract guide

The generated OpenAPI document is the exhaustive Trading Max HTTP contract:

- source contract: [`contracts/openapi.json`](../../contracts/openapi.json);
- local interactive documentation: `http://127.0.0.1:8421/docs`;
- local OpenAPI JSON: `http://127.0.0.1:8421/openapi.json`.

Do not maintain a second handwritten endpoint inventory. Backend response
models generate the contract, and `openapi-typescript` generates the frontend
schema. CI rejects drift on either side.

## Route groups

| Group | Prefix | Purpose |
|---|---|---|
| Health | `/health`, `/ready` | Liveness and full runtime readiness |
| Dashboard | `/v1/dashboard/lens/` | Small overview, holdings, analytics, and account projections |
| Research | `/v1/research/` | Directory, ticker shell, lenses, prices, history, events, models, impact, and alerts |
| Watchlist | `/v1/watchlist` | Local ticker collection and per-ticker refresh |
| Jobs | `/v1/jobs` | Durable refresh submission, status, logs, and cancellation |
| Snapshots | `/v1/snapshots` | Immutable manifests and artifact retrieval |
| Alerts | `/v1/alerts` | Lightweight monitor status and forced refresh |
| Analysis | `/v1/analysis` | Typed optional LLM runs and immutable outputs |
| Settings | `/v1/settings` | Tested local integrations and LLM route policy |
| Valuation | `/v1/valuation` | Versioned per-ticker DCF assumptions and history |

The legacy aggregate `/v1/dashboard` remains a typed compatibility surface.
Interactive pages use interface-lens endpoints so unrelated price histories and
research payloads are not transferred on every navigation.

## Write authorization

All mutating routes require the server-side write token. The browser sends
writes through the Next.js backend proxy; the token is never exposed to client
JavaScript. Production mode also enforces loopback binding, allowed origins,
Fetch Metadata, request-size limits, and rate limits.

Credentials are tested before persistence and stored by the operating-system
credential manager. API responses return connection metadata, never secret
values.

## Data and error semantics

- Snapshot reads return the last fully published immutable run.
- Missing required data fails visibly with a typed error; it is not represented
  as a fabricated zero.
- Accepted refresh and analysis requests return durable job/run identifiers.
- A stage failure records its stage, timing, return code, and error while leaving
  the previous valid snapshot available.
- Research payloads include provenance and freshness metadata where the source
  contract supports it.

## Contract checks

```bash
uv run python tools/generate_openapi.py --check
npm --prefix apps/web run check:api-types
```

When a backend model changes, regenerate both surfaces before opening a pull
request:

```bash
uv run python tools/generate_openapi.py
npm --prefix apps/web run generate:api-types
```
