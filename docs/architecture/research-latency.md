# Research latency and interaction boundaries

Research remains an independent, typed projection of a complete immutable
snapshot. The workbench can also show genuine price history while the first
research job is running. A price response does not imply that financials,
estimates, or the full research job have completed.

## Request scope

The research lens endpoint defaults to `detail=full` for compatibility.
The workbench uses smaller projections for the task being displayed:

| View | Detail | Contents |
| --- | --- | --- |
| Overview | summary | Quote/context, four current financial facts, business profile, next earnings window, three filings, portfolio exposure |
| Technical chart/data | summary | Technical readings and earnings calendar, without seasonality histories |
| Seasonality | seasonality | Monthly observations and year paths |
| Financial analysis | summary | Normalized facts and evidence; complete raw statements are fetched when opened |
| Notes/models | summary | Context; the journal is an independent query |
| Disclosures/news | documents | Actual filings/news, without historical lens snapshots, model history, or full financial facts |

The 3M overview uses `prices?interval=1d&window=3M`. Where a published full
history exists, the API projects the same last 90 calendar days used by the
client. For an unresearched security it requests six months of genuine daily
OHLCV, with a separate cache identity. That preview does not supply technical
indicators; it cannot overwrite the full-history cache. Full charts still
calculate indicators before trimming the visible window. No synthetic points,
interpolation, or portfolio NAV sampling changes are involved.

## Caching and concurrent work

- Bounded single-flight caches coalesce identical loads. Their mutex protects
  only cache bookkeeping; unrelated keys do not wait for network I/O.
- Price freshness uses the provider fetch timestamp, including for disk cache
  reads. Reading an old file cannot extend its freshness.
- API routes receive private price model copies before slicing or adding
  markers. Parser results are shared read-only.
- Lens caches use relevant artifact revisions. Financial input versions use
  the issuer's financial payload, so adding another issuer to an aggregate
  artifact does not make an unchanged valuation input stale. Dataset clocks
  still identify the aggregate artifact.
- Artifact reference validation is reused only for unchanged inode, size,
  mtime, and ctime. Modified or replaced files are verified again. Snapshot
  manifests/pointers retain their hash checks and atomic publication.
- Independent benchmark requests and filing reads use at most three workers.
  Parsed immutable filings are cached by document/form/date/parser version;
  results retain provider order, per-document failures, and amendment precedence.
  Durable worker stages and the snapshot publication barrier remain intact.

## Client interactions

Query factories share resource identities across charts, comparisons, and
analyst views. Abort signals reach the BFF and backend transport. Closing a
comparison removes its observers; shared visible consumers can keep their
request. Durable research jobs and saves are not cancelled by navigation.

Same-security refreshes can retain an existing projection. Placeholder data
cannot cross tickers, views, or projection detail. The overview chart and
technical chart mount independently of the financial lens. Valuation editing
retains its debounce and previous result; the initial GET is reused instead of
immediately repeating it with a POST. Equal baseline/scenario requests share
one key. Hidden year-record tables mount only when opened.

## Verification

`Server-Timing` exposes lens processing and cache hit/miss/coalesced status
through the BFF alongside the backend round trip. Filing timings are written
to local service logs without document contents. Browser performance and UI
screenshots are collected by external QA scripts, not by product telemetry.

Measure cold and warm states separately. A new issuer's first chart, the whole
research job, API response time, and browser event duration are different
measurements. Neither automation acknowledgement time nor a small event sample
is a real-user INP result. External provider latency and intermittent HTTPS
connection delays must be reported separately from application improvements.
