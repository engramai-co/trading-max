# Preview with simulated broker accounts

The interactive preview simulates **Trading 212 inputs only**: balances,
quantities, fills and cash movements. Prices, FX, benchmarks, financial
statements, analyst estimates, options, security profiles and ETF holdings use
the production adapters. NAV is calculated from the hypothetical ledger and
observed historical prices. An unavailable provider leaves unavailable data.
Automated tests continue to use entirely synthetic fixtures and no real accounts.

Keep the fixture, state, provider caches and logs outside the checkout. Supply
`tools/build_broker_preview.py` with an external JSON fixture containing:

- `start_date` and `deposit_date` in ISO date format;
- `fills`, each containing a `date` and `fraction` (fractions total one);
- `accounts.invest` and `accounts.isa`, each with a `positions` mapping from
  provider symbol to hypothetical quantity, `cash_gbp`, and optional
  `cash_flows` with `action`, `date` and signed GBP `amount`;
- optional `research_tickers` for additional research coverage.

The builder derives simulated fills from earlier observed closing prices. These
remain hypothetical broker executions. Split-crossing fixtures are currently
unsupported: choose fill dates after the relevant splits. The builder never
changes a real security's price history to accommodate a fixture.

```bash
uv run python tools/build_broker_preview.py \
  --state-root "$preview_state" --broker-fixture "$broker_fixture"
uv run python tools/serve_broker_preview.py \
  --state-root "$preview_state" --port 8424 --web-port 3415
```

This terminal runs the API and worker. In a second terminal at the same
checkout, build and start the preview frontend with the supported Node version:

```bash
npm --prefix apps/web run build
HOSTNAME=127.0.0.1 PORT=3415 \
  PORTFOLIO_BACKEND_URL=http://127.0.0.1:8424 TRADING_MAX_PROXY_TOKEN= \
  node apps/web/.next/standalone/server.js
```

Open [http://127.0.0.1:3415](http://127.0.0.1:3415). Both ports must be free;
if changed, keep `--web-port`, `PORT`, and the backend URL aligned. Stop each
foreground process with `Ctrl-C` in its own terminal. The preview does not
load the ordinary installation's bootstrap or credentials.

Use `--resume` on the builder to retry an interrupted build with its existing
inputs. Completed provider artifacts are retained; retried dependencies
invalidate their dependent stages even when a retry fails. Failed or removed
stage outputs cannot be republished from the old checkpoint. Start a new build
when changing the fixture. Resume is not a market-data refresh: it can reuse
unchanged completed stages from the earlier build.
The builder requires an empty directory or its `BROKER_MOCK_ONLY` marker and
refuses an old `SYNTHETIC_DEMO_ONLY` state. A clean publication cannot inherit
market artifacts from an older fully fictional preview.

The preview server binds to loopback. It replaces only the broker sync stage;
the normal worker handles live observations, full NAV reconstruction and
research refreshes. It does not configure network exposure or install a service.
Unconfigured model routes fail explicitly and cannot publish a fake synthesis.
The worker stops with the server. Raw simulated CFD exports can be imported via
the existing Trading 212 CFD import flow and are processed by the same normal
account stages.

To bring an existing preview up to date, start the preview server and use
**Data status → Start update**. The **Performance** scope replays the portfolio
history from existing simulated broker inputs and current historical market
data. **Latest account state** (`live`) refreshes the simulated holdings' latest quotes; **Research**
refreshes company price history and research. A full update also re-resolves
the reference catalog and ETF look-through and can take longer. Follow the
job to completion and inspect the final observation dates: a new publication
timestamp alone does not mean that all provider histories are current.

Historical reconstruction stays marked as reconstruction. Do not create old
broker observations by interpolating a chart or assigning today's price to
earlier timestamps. Missing provider bars, market closures, and unavailable
overnight sessions retain their actual coverage.

After the first broker observation, the chart intentionally keeps observed
history separate from later reconstruction. An old preview with only sparse
simulated snapshots may therefore still show a gap after a market-data refresh.
For a new demonstration baseline, preserve the old preview and build a new
isolated state from the hypothetical fixture. Keep historical points marked
as reconstruction; do not relabel them as observed broker records to fill a chart.

`preview-provenance.json` records the build's publication and producer versions.
The immutable snapshot manifest remains authoritative after later refreshes.
Check the provider's own `as_of` date: a newly downloaded ETF disclosure can
describe an earlier portfolio. The iShares product adapters and Vanguard's
[fund directory](https://www.vanguard.co.uk/uk-fund-directory/product/etf/equity/9679/ftse-all-world-ucits-etf-usd-accumulating)
retain that date, issuer source link, full pagination and reported weights.
Cash, derivatives and bonds remain distinct from equity constituents.

The [valuation-history decision](../architecture/unified-nav-history.md)
documents the ten-minute valuation grid, separate display sampling, source
precedence and unavailable-price behavior.
