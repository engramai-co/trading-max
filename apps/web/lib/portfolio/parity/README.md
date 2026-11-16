# Python portfolio math parity

Update the committed synthetic fixtures from the repository root using Node 22:

```sh
UPDATE_PORTFOLIO_PARITY=1 npm --prefix apps/web test -- lib/portfolio/parity
uv run pytest backend/tests/portfolio_math
```

The normal web test run compares the committed fixture bytes with newly
calculated TypeScript results. The Python test then runs the same inputs
against the backend implementation. When a web calculation changes, update
the Python port and regenerate together. Do not edit expected values by hand
or use actual account data in these cases.

Each case names the Python function, identifies the scenario and contains
its TypeScript argument list and result. Selection takes an object instead
of positional arguments, and named opening cases first prepare their
snapshot. Timeline segments store the complete grid and its row indexes
losslessly with the web timeline codec; Python expands the fixture with an
independent test decoder. Undefined object fields are omitted; explicit null
stays null. A root undefined result uses `{"$js":"undefined"}` (the Python
`deepest_drawdown` API returns `None` to indicate no episode). The same envelope
retains IEEE NaN, both infinities, and negative zero, which ordinary JSON
serialization would lose. Dates, strings, nulls, flags, signed zeros and
integers compare exactly. Nonintegral floats use absolute tolerance
`1e-9` and relative tolerance `1e-12` for binary64 arithmetic; there are no
field exceptions.

The Python package accepts the API's camelCase history dictionaries. Send
`model_dump(mode="json", by_alias=True, exclude_none=True, exclude_defaults=True)`
from a validated history response model to preserve its wire shape. Pass
`"1W"` for the UI's **5D** and `"ALL"` for **All**:

- `select_portfolio_history(range=..., scope=..., daily=..., intraday=..., as_of=..., require_cash_flows=...)` returns the full observations, coverage and source metadata.
- `portfolio_money(points, scope)` returns period P&L, contributions, value changes, full drawdown, and its observations.
- `prepare_history(snapshot, {"range": ..., "scope": ...})` selects cash-flow-reconciled history and calculates money from every eligible observation. It keeps the run ID, data revision and source count. `pnls_at(prepared, instants)` gets exact P&L around named instants.
- `return_periods(points, scope, as_of=None)` returns the monthly, quarterly and annual grid. For the Returns view's range summary, use `in_range` on daily rows, keep scoped NAV, and then use `benchmark_comparison(points, scope, series, names)` for the common dates. Apply `period_return` to the first scoped TWR and each subsequent scoped TWR, then `drawdowns(values, compounded=True)` and `deepest_drawdown` for return drawdown.
- `drawdown_episodes(values)` returns observed recovered, open and interrupted episodes by point index.

The port keeps original observations and coverage but skips chart thinning,
stroke rendering and pagination. Those operations do not change reported
amounts; the existing web tests check display geometry separately.
Millisecond arithmetic truncates fractional timestamps before sorting, then
uses Europe/London calendar days. The snapshot contract uses ISO dates or
explicitly offset times. For legacy ISO timestamps with no offset, Python
assumes UTC, consistent with the API projection; JavaScript may use the host
time zone. Named instants reject missing offsets on both sides.

Two details to preserve when interpreting an answer: the **5D** Money view counts
five weekdays, while Returns filters by seven elapsed days. Missing weekdays
(including holidays) stay visible as gaps. Internal household transfers are
already reflected in the API's cumulative contribution fields: the portfolio
calculation only subtracts the change in those fields, it does not reconcile
a second copy of the ledger.
