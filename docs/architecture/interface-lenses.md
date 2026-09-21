# Interface lens architecture

Trading Max loads each product interface as an independent **lens**. A route
must render its stable navigation and page heading before private portfolio
data is available, then request only the payload needed by the active view.

## Dashboard lenses

| Interface | API lens | Payload boundary |
| --- | --- | --- |
| Overview | `overview?detail=summary` | Totals, investable accounts, direct holdings and held-security signals; period P&L loads independently |
| Holdings · positions | `holdings-positions` | Direct positions and portfolio totals |
| Holdings · look-through | `holdings-lookthrough` | ETF/entity-resolved look-through only; fetched after the view is selected |
| Performance | `analytics?detail=summary` | Account summaries, daily NAV, risk and policy metrics; money charts use the pinned history endpoint |
| Account detail | `account-analysis?account=A|B|C` | One account, its metrics, report, holdings and relevant NAV history |

The FastAPI contract is `DashboardLensSnapshot`. Fields outside the selected
lens are omitted from the JSON response, not merely ignored by the frontend.
The Next.js BFF validates the lens and account before forwarding the request.

## On-demand portfolio history

`GET /v1/dashboard/history?run_id=…&range=6M&scope=total` reads a pinned typed
snapshot through the bounded SQLite query index. It loads only the NAV and
cash-flow artifacts needed for this projection, preserving the original first
observation, first broker boundary and latest point as window context. The
public full dashboard/lens defaults remain compatible. `detail=summary` skips
the intraday artifact and its cash-flow projection.

The Next.js history endpoint computes the existing `selectPortfolioHistory`
and `portfolioMoney` functions on **all eligible observations**, before selecting
display points. It returns the exact summary, existing sampled observations,
corresponding full-history drawdowns, and compact calendar geometry. Empty grid
slots are display coordinates, not fabricated financial records. The plotting
cadence and gap rules are identical to the full-source path.

Both overview and performance pin the chart to the parent lens's `runId`.
Opening the exact-record table fetches 20 records; subsequent pages use the
same snapshot, range and scope. Missing snapshots fail explicitly rather than
silently switching to the latest version. All responses are private/no-store,
and client requests use cancellable, selection-specific query keys.

The server preparation cache holds at most two selections, 32 MiB of serialized
results and ten minutes of lifetime. This is a cache budget, not a JavaScript
heap ceiling. At most four distinct computations may be in flight. Eviction
rebuilds the requested view from its original immutable snapshot. The browser
does not need the entire source history to render a curve or its summary.

## Other product lenses

- Research keeps a small ticker directory shell and independently loads the
  active ticker/view lens. Price history is a separate bounded endpoint.
- LLM analysis is an independent lens. Loading or regenerating analysis never
  blocks the underlying portfolio or research data.
- Settings loads integration state in the client; valuation assumptions remain
  an independent operational panel.
- Health is an independent client surface and never participates in portfolio
  page rendering.

## UX contract

1. Navigation and the page heading render immediately.
2. A lens owns its skeleton, error message and retry action.
3. Failures are local: another lens remains navigable and usable.
4. Lazy views do not fetch before selection.
5. Skeletons reserve the final layout area to avoid cumulative layout shift.
6. Query retries are bounded so an unavailable backend does not leave an
   interface appearing frozen.

## Change policy

New dashboard interfaces must add a value to `DashboardLensName`, project a
typed response in the API route, regenerate OpenAPI/TypeScript types, and add
an API test proving unrelated fields are absent. Reintroducing the monolithic
`/v1/dashboard` response into a page route is an architecture regression.
