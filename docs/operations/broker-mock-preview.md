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
remain hypothetical broker executions. It rejects a fixture crossing a share
split until that fixture supplies a supported split-aware ledger; it never
silently changes a real security's price history to accommodate the fixture.

```bash
uv run python tools/build_broker_preview.py \
  --state-root "$preview_state" --broker-fixture "$broker_fixture"
uv run python tools/serve_broker_preview.py --state-root "$preview_state" --port 8424
```

Use `--resume` on the builder to retry an interrupted build with its existing
inputs. Completed provider artifacts are retained; retried dependencies
invalidate their dependent stages. Start a new build when changing the fixture.
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
