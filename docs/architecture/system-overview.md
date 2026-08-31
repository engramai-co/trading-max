# System overview

Trading Max V1 is a local-first, single-user application with four runtime
layers:

```text
Next.js UI and BFF
        │
        ▼
FastAPI control plane ──> SQLite queue and settings metadata
        │
        ▼
Durable worker ──> broker, analytics, research, and optional LLM stages
        │
        ▼
Immutable snapshot and analysis artifacts
```

## Runtime boundaries

- `apps/web` renders the interface and proxies browser requests without
  exposing backend write tokens or provider credentials.
- `services/api` validates HTTP contracts, authorizes writes, schedules work,
  and projects immutable artifacts into small interface lenses.
- `backend` owns domain models, broker ingestion, analytics, reference data,
  research, persistence, and worker execution.
- SQLite stores durable job state and local settings metadata. Provider secrets
  live in the operating-system credential manager.

The web and API bind to loopback in the supported local profile. Trading Max is
not designed as a public-internet or multi-user service.

## Snapshot publication

Each successful full run is published into a new immutable directory. A
manifest records artifact identity, schema, checksums, dependencies, provenance,
freshness, and quality. `latest.json` moves atomically only after every required
artifact validates, so a failed refresh leaves the previous snapshot readable.

Research and LLM artifacts bind to a snapshot identity rather than silently
mutating dashboard values. Missing or stale inputs remain visible instead of
being replaced with zero-value estimates.

## Refresh paths

Trading Max has three independent refresh paths:

1. **Full refresh** — synchronizes broker data, recomputes account/performance,
   look-through, reference, and research stages, then publishes atomically.
2. **Intraday NAV anchor** — reads current broker values and appends a bounded
   anchor without rerunning research or LLM analysis.
3. **Alert monitor** — updates held positions more frequently than the wider
   watchlist, then recomputes lightweight price, technical, concentration,
   valuation, freshness, and options alerts.

The queue prioritizes full refreshes. The latest missed scheduled full run may be submitted
once after process recovery; missed intraday slots are never replayed.

## Performance semantics

Official daily account series use verified cash-flow-aware calculations.
Intraday anchors do not contain complete cash-flow coverage, so short-range
surfaces label them as value change rather than TWR. Longer ranges use the
official daily series.

## LLM boundary

LLM analysis is optional and additive. Routes select a trusted provider/model
pair from persisted policy; the browser cannot supply arbitrary upstream URLs.
Responses are validated against typed contracts and stored with input hashes,
snapshot identity, provider, model, and timestamps. An LLM failure cannot roll
back valid portfolio or research data.

## Operations and recovery

Local setup, health/readiness acceptance, backup, restore, and optional macOS
service installation are documented separately:

- [Local installation](../installation/local-installation.md)
- [Agent onboarding](../operations/agent-local-deployment-runbook.md)
- [Durable job runtime](durable-job-runtime.md)
- [Interface lenses](interface-lenses.md)
