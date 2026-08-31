# Third-party software, APIs, and data sources

This file records the external software and services that Trading Max can use.
It is an attribution and provenance map, not a grant of rights to third-party
data. The [Apache License 2.0](LICENSE) covers Trading Max source code only.

Trading Max does not vendor provider SDK source, broker exports, portfolio
snapshots, market-data responses, model output, issuer documents, or cached
company logos. Python and npm packages are installed from the lockfiles and an
SPDX SBOM is generated for every release.

## Runtime services and data sources

| Source | How Trading Max uses it | Boundary and attribution |
|---|---|---|
| [Trading 212 Public API](https://docs.trading212.com/api) | Read-only Invest and Stocks ISA account summary, positions, transactions, dividends, orders history, and user-requested exports | The user creates their own key and must select read-only permissions. Trading Max independently implements an allowlisted HTTP adapter and never calls order-placement endpoints. Use is subject to the [Trading 212 API Terms](https://www.trading212.com/legal-documentation/API-Terms_EN.pdf). Trading Max is not affiliated with or endorsed by Trading 212. |
| [yfinance](https://github.com/ranaroussi/yfinance) | Python interface for Yahoo Finance-compatible prices, FX, security profiles, financials, estimates, options, and calendars | `yfinance` is an Apache-2.0 dependency and is not affiliated with Yahoo. Its own documentation says downloaded Yahoo Finance data is intended for personal use and directs users to Yahoo's terms. Trading Max does not redistribute downloaded data. |
| [OpenFIGI](https://www.openfigi.com/api/documentation) | Optional identifier mapping and security identity resolution | The API is free and public with lower unauthenticated rate limits. FIGI identifiers are dedicated to the public domain under the [OpenFIGI Terms](https://www.openfigi.com/docs/terms-of-service). OpenFIGI and Bloomberg marks are used only for identification; no endorsement is implied. |
| [SEC EDGAR developer resources](https://www.sec.gov/about/developer-resources) | U.S. issuer name/ticker reference and public filing provenance | Trading Max uses public SEC endpoints with bounded requests and an identifying User-Agent. SEC responses are cached locally and are not committed to source. |
| [iShares](https://www.ishares.com/uk/individual/en/products/340748), [Invesco](https://www.invesco.com/uk/en/financial-products/etfs/), and [HSBC Asset Management](https://www.assetmanagement.hsbc.co.uk/en/individual-investor/funds/ie000kcs7j59) | Published ETF holdings, country, and sector look-through for supported funds | The adapters retrieve issuer-published files or responses for the local user's analysis. Provider documents and downloaded holdings are not included in source distributions. Issuer names and marks remain their owners' property. |
| [OpenCode](https://opencode.ai/), [DeepSeek](https://api-docs.deepseek.com/), and optional OpenAI-compatible providers | Optional, user-configured synthesis of bounded portfolio or research context | Disabled unless the local user supplies a key and route. Provider handling, retention, and training policies apply to context sent by that user. |
| [Exa](https://exa.ai/) | Optional last-resort public-web entity resolution through a configured model/tool route | Queries are sent only when local, OpenFIGI, and SEC resolution fail. Returned URLs are evidence, not security-identity truth. |
| Parqet logo assets and Google favicon service | Best-effort company marks in the interface | Requests are proxied and bounded by the local server; cached files remain outside Git. Logos are decorative, never block financial data, and are not redistributed in releases. |

## Direct open-source dependencies

The complete transitive inventory is the release SBOM. Principal direct
dependencies include:

| Package family | Licence |
|---|---|
| FastAPI, Keyring, Mantine, Phosphor Icons, TanStack Query, Next.js, React | MIT |
| httpx, Uvicorn | BSD-3-Clause |
| yfinance, Apache ECharts | Apache-2.0 |
| NumPy, pandas, Pydantic, pypdf, xlrd and their transitive dependencies | See the exact version metadata and release SBOM |

Their licences apply to those packages, not to broker or market data obtained
through them.

## Reference metadata

The repository includes small, reviewable interoperability datasets under
`backend/src/trading_max/reference/data`. They contain identifier mappings,
historical listing facts, and taxonomy node metadata—not user holdings,
provider downloads, or licensed issuer-level GICS assignments. Each dataset
records provenance and a scope notice in the file itself.

## Trademarks and non-affiliation

Trading 212, Yahoo, Bloomberg, OpenFIGI, GICS, all issuer names, company names,
fund names, and provider names are trademarks or service marks of their
respective owners. Naming an integration describes compatibility only. See
[TRADEMARKS.md](TRADEMARKS.md) for the Trading Max brand policy.

## User responsibility

Users must review the current terms, permissions, rate limits, and
redistribution rules of every provider they enable. A provider being reachable
or free of charge does not make its downloaded data open source. If a provider
does not permit the intended use, leave that integration disabled.
