<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/trading-max-lockup-dark.svg">
    <img src="apps/web/public/brand/trading-max-lockup.svg" alt="Trading Max" width="460">
  </picture>
</p>

<h3 align="center">Your portfolio, explained.</h3>

<p align="center">
  A private, read-only investment workspace for Trading 212, in English or Chinese.<br>
  See what changed, look beneath every fund, follow markets around the world and keep research beside your holdings.
</p>

<p align="center">
  <a href="https://github.com/engramai-co/trading-max/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/engramai-co/trading-max?style=flat-square&color=1768E5&label=release"></a>
  <a href="https://github.com/engramai-co/trading-max/releases/latest"><img alt="macOS on Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-17191C?style=flat-square&logo=apple&logoColor=white"></a>
  <a href="LICENSE"><img alt="Apache 2.0 licence" src="https://img.shields.io/github/license/engramai-co/trading-max?style=flat-square&color=17191C"></a>
  <img alt="Read-only broker access" src="https://img.shields.io/badge/broker%20access-read--only-2F7D4C?style=flat-square">
</p>

<p align="center">
  <a href="https://tradingmax.engramai.co"><b>Website</b></a> ·
  <a href="https://github.com/engramai-co/trading-max/releases/latest"><b>Download for Mac</b></a> ·
  <a href="#run-from-source"><b>Run from source</b></a> ·
  <a href="docs/README.md"><b>Guides</b></a>
</p>

<p align="center">
  <img src="docs/assets/workspace-overview.png" alt="Trading Max overview: account value, a year of period net P&L, today's US sector map and the holdings panel" width="100%">
</p>

## What you get

- **Results, not deposits.** Net P&L and returns stay separate from money moving
  in and out, for Invest and Stocks ISA together or one account at a time, with
  drawdowns and a benchmark beside them.
- **Markets worldwide.** Global and regional indices, a world map of today's
  moves with each market's contribution to MSCI ACWI, and sector maps for major
  markets with breadth and your own exposure in each sector.
- **Look-through.** Your direct shares combined with the constituents ETF issuers
  publish: the companies, sectors and countries you actually own, and where they
  overlap.
- **Research beside your holdings.** Stocks, funds and indices share one
  research list: financials, price and technicals, estimates, valuation
  scenarios, options and your journal. Funds add holdings overlap, tracking
  difference and US peer ETFs; indices add constituents, breadth and the funds
  that track them. Your trades sit on the charts.
- **Investment review.** Your recent buys and sells set against what happened
  next, plus large moves without a trade, cash that stayed high and drifting
  weights.

<p align="center">
  <img src="docs/assets/markets-sectors.png" alt="Markets, US sectors: US index cards, the S&P 500 sector map sized by index weight and the Information Technology detail with its intraday path, breadth and your exposure" width="49%">
  <img src="docs/assets/holdings-exposure.png" alt="Look-through by company as a composition ring, with AMD's value held directly and via funds" width="49%">
</p>
<p align="center">
  <img src="docs/assets/research-technicals.png" alt="AMD price and technicals: a year of daily candles with your buys marked beneath, and its technical score" width="49%">
  <img src="docs/assets/research-valuation.png" alt="Bloom Energy valuation: bear, base and bull scenarios against the current price, with editable assumptions" width="49%">
</p>

<p align="center"><sub>Screenshots use a hypothetical portfolio. Market and company data come from real providers and show dated examples, not live quotes.</sub></p>

## Get started

### Mac App

1. Download the DMG from the [latest release](https://github.com/engramai-co/trading-max/releases/latest).
   It runs on Apple Silicon and is Developer ID signed and Apple-notarized.
   Version 1.52.0 requires macOS 13.0 or later, and releases after 1.67 require macOS 13.3 or later.
2. Open it and drag **Trading Max** to Applications.
3. Start a local workspace, connect to your own Trading Max service over HTTPS,
   or open the demo with synthetic data.
4. In **Workspace settings**, add your read-only Trading 212 API keys, run the
   first sync and check the totals against Trading 212.

Updates install from **App Settings → About & updates**. See the
[desktop guide](docs/installation/desktop-onboarding.md).

### Run from source

You need Git, Python 3.12, [uv](https://docs.astral.sh/uv/) and Node.js 22
(22.19 or newer).

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
uv run --package trading-max-backend trading-max onboard
deploy/local/start.sh
```

Then open <http://127.0.0.1:3413>. `onboard` installs the locked dependencies,
keeps your data outside the checkout, builds the web app and can connect
Trading 212. The [source guide](docs/archive/onboarding/local-installation.md)
covers background services, updates and backups.

## Your data stays yours

- **Read-only.** There is no order-placement path. Trading Max never trades.
- **Local.** Credentials live in the operating-system keychain. Data stays on
  your machine or your own server, on loopback by default.
- **Sourced.** Every figure keeps its basis, source and as-of time. Stale or
  failed data is disclosed, never papered over.
- **AI optional.** Analytics and research work without a model key.

Trading 212 supplies account data. Yahoo-compatible market data, SEC filings
and ETF issuers supply research; Alpaca and EODHD can add more market data.
See [Privacy](PRIVACY.md) and [data conventions](docs/guides/data-and-metrics.md).

## Learn more

| I want to… | Start here |
|---|---|
| Understand my portfolio | [Portfolio guide](docs/guides/portfolio.md) |
| Research a stock, fund or index | [Research guide](docs/guides/research.md) |
| See which funds are looked through | [ETF coverage](docs/guides/etf-coverage.md) |
| Install, update or recover the App | [Desktop guide](docs/installation/desktop-updates.md) |
| Understand the architecture or API | [Documentation index](docs/README.md) |
| Get help or contribute | [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) |
| See what shipped | [Changelog](CHANGELOG.md) · [Releases](https://github.com/engramai-co/trading-max/releases) |

## License

Trading Max is open source under the [Apache License 2.0](LICENSE). It is an
independent project, not affiliated with or endorsed by Trading 212, Yahoo,
Alpaca, EODHD, Bloomberg/OpenFIGI, index providers, ETF issuers or model
providers, and nothing here is investment advice. See
[third-party notices](THIRD_PARTY_NOTICES.md) and
[trademarks](TRADEMARKS.md).
