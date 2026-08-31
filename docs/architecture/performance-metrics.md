# Performance metric conventions

Trading Max calculates performance from valuation points, not from deposits or
realized trade P&L alone. Each point has a value and a `external_flow`; the
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
- Sortino using the downside-only interval series;
- maximum/current drawdown from the cumulative return curve;
- Calmar as annualized return divided by absolute maximum drawdown;
- Information Ratio from active returns against a same-length benchmark.

Undefined ratios return `null` rather than inventing a zero when the series is
too short or has no downside/active volatility. Account-specific annualization
frequency and benchmark identity remain explicit inputs at the application
boundary.
