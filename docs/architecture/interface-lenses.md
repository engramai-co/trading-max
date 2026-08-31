# Interface lens architecture

Trading Max loads each product interface as an independent **lens**. A route
must render its stable navigation and page heading before private portfolio
data is available, then request only the payload needed by the active view.

## Dashboard lenses

| Interface | API lens | Payload boundary |
| --- | --- | --- |
| Overview | `overview` | Totals, investable accounts, direct holdings, held-security signals, latest NAV point |
| Holdings · positions | `holdings-positions` | Direct positions and portfolio totals |
| Holdings · look-through | `holdings-lookthrough` | ETF/entity-resolved look-through only; fetched after the view is selected |
| Performance | `analytics` | Account summaries, NAV history, intraday anchors, risk and policy metrics |
| Account detail | `account-analysis?account=A|B|C` | One account, its metrics, report, holdings and relevant NAV history |

The FastAPI contract is `DashboardLensSnapshot`. Fields outside the selected
lens are omitted from the JSON response, not merely ignored by the frontend.
The Next.js BFF validates the lens and account before forwarding the request.

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
