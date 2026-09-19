# Performance metric conventions

Trading Max calculates performance from valuation points, not from deposits or
realized trade P&L alone. The generic primitive has a value and an `external_flow`; the
flow is assumed to occur immediately before that point's valuation. For an
interval from `V[t-1]` to `V[t]`:

```text
r[t] = V[t] / (V[t-1] + external_flow[t]) - 1
TWR  = product(1 + r[t]) - 1
```

The convention is encoded in
`backend/src/trading_max/analytics/performance.py` and must be adapted or
rejected when only intraday flow timing is available. It prevents a deposit
from appearing as investment return.

The same module defines:

- annualized return from the compounded interval returns;
- annualized volatility and Sharpe using sample standard deviation;
- Sortino using the root mean square of negative excess returns across all
  intervals, with nonnegative excess returns contributing zero;
- maximum/current drawdown from the cumulative return curve;
- Calmar as annualized return divided by absolute maximum drawdown;
- Information Ratio from active returns against a same-length benchmark.

Undefined ratios return `null` rather than inventing a zero when the series is
too short or has no downside deviation or active volatility. Account-specific annualization
frequency and benchmark identity remain explicit inputs at the application
boundary.

## Reconciled account histories

The broker-ledger replay in `analytics/historical_nav.py` has dated cash
movements and uses a daily Modified Dietz estimate before chaining returns:

```text
r[t] = (V[t] - V[t-1] - external_flow[t])
       / (V[t-1] + weighted_external_flow[t])
```

The weighted flow reflects when the cash movement occurred within the daily
interval. `application/performance_stages.py` consumes the resulting
`TWRWealth` series with zero additional external flow, so it does not deduct
the same deposit twice. This chained daily estimate is distinct from an exact
intraday time-weighted return at every cash-flow timestamp.

Replacing a same-day broker mark retains the reconciled flows for that day.
After missed collection dates, replay uses available historical prices and
retains explicitly identified earlier broker observations and their timestamps.
Flows enter the first valuation interval ending at or after the event; weekend
or later same-day deposits cannot be assigned to an earlier broker mark.
Legacy marks without an observation time remain visible, but same-date flow
ambiguity suppresses performance. Missing cash-flow evidence also suppresses
performance and affected P&L; it does not become a zero flow. API projections
must preserve this unavailability rather than recomputing it from NAV.
