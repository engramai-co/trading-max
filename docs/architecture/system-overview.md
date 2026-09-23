# System overview

Trading Max 1.x is a local-first, single-user application with four runtime
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
- SQLite stores durable job state and local settings metadata. Separate,
  rebuildable SQLite indexes accelerate immutable-object lookup and selected
  history queries; they do not replace the original financial records. Provider
  secrets live in the operating-system credential manager.

See [repository layout](repository-layout.md) for code ownership and generated
files, and [interface lenses](interface-lenses.md) for the browser/API boundary.

The web and API bind to loopback in the supported local profile. Trading Max is
not designed as a public-internet or multi-user service.

## Snapshot publication

Each successful publication creates an immutable snapshot manifest. Artifacts
are content addressed and may reuse objects from earlier runs; a snapshot is
not a full copy of the application state. A
manifest records artifact identity, schema, checksums, dependencies, provenance,
freshness, and quality. `latest.json` moves atomically only after every required
artifact validates, so a failed refresh leaves the previous snapshot readable.

Research and LLM artifacts bind to a snapshot identity rather than silently
mutating dashboard values. Missing or stale inputs remain visible instead of
being replaced with zero-value estimates.

## Refresh paths

Settings exposes three independent scheduled workloads:

| Workload | Scope | Work performed |
|---|---|---|
| Account state & intraday history | `live` (`intraday` remains a compatibility alias) | Read current broker values, normalize accounts, append observed NAV, publish |
| Performance calculations | `performance` | Reuse current broker inputs, replay account NAV and calculate returns/risk, publish |
| Research & daily reconciliation | `research`, plus scheduled `accounts` reconciliation | Refresh research and position-dependent look-through, then reconcile official account history at the configured daily time |

A manual **full refresh** (`all`) runs the combined broker, account, reference,
look-through, research and performance pipeline. The alert monitor is separate:
it updates held positions more frequently than the wider watchlist and
recomputes lightweight alerts. These are not three copies of one full job.

The durable queue arbitrates priority and coalesces conflicting work. A busy
live slot may retry while still current; expired live slots are never replayed
as broker observations. See [worker and scheduler behavior](durable-job-runtime.md).
Fresh local setup starts scheduled collection disabled; operator-managed hosts
may have different retained preferences. Settings shows the effective schedule.

## Performance semantics

All money/P&L ranges share ending value, net contributions, period net P&L,
and maximum P&L drawdown. Ranges through 6M use the unified intraday
valuation history; YTD follows its elapsed span, while 1Y and All use daily
values. Older daily-only coverage stays daily. Reconciled timestamped cash-flow
evidence qualifies the P&L calculation. Missing evidence leaves P&L unavailable.
The independent daily performance path remains authoritative for TWR; a
percentage of opening account value is not TWR. See
[unified NAV history](unified-nav-history.md).

## History reads and storage

The overview and performance summary load independently of chart history. A
pinned history request uses the parent snapshot ID and selected range/scope;
the browser receives chart points and fetches exact records a page at a time.
P&L and drawdown are calculated before display sampling. Daily risk/TWR keep
their independent history path.

Optional compressed envelopes, shared chunks and sealed object packs preserve
original artifact bytes and provenance. Conversion is separately verified and
requires compatible retained readers. Backups own independent recovery data,
with bounded retention that protects unique history. Derived query caches can
be rebuilt from snapshots. See [history storage](history-storage.md),
[object packs](immutable-object-packs.md) and the
[operator procedure](../operations/storage-maintenance.md).

## LLM boundary

LLM analysis is optional and additive. Routes select a trusted provider/model
pair from persisted policy; the browser cannot supply arbitrary upstream URLs.
Responses are validated against typed contracts and stored with input hashes,
snapshot identity, provider, model, and timestamps. An LLM failure cannot roll
back valid portfolio or research data.

## Operations and recovery

Local setup, health/readiness acceptance, backup, restore, and optional macOS
service installation are documented separately:

- [Desktop onboarding](../installation/desktop-onboarding.md)
- [Archived source/agent installation](../archive/onboarding/README.md)
- [Durable job runtime](durable-job-runtime.md)
- [Interface lenses](interface-lenses.md)
