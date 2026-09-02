# Trading Max Portfolio

Trading Max is a local-first, single-user portfolio intelligence application.
It combines read-only Trading 212 account data, portfolio analytics, ETF
look-through, market research, valuation, options structure, and optional LLM
analysis in one auditable workspace.

> **Status:** V1 beta. The supported boundary is a local, single-user macOS
> installation. The project is read-only and does not provide investment,
> tax, legal, brokerage, or uptime advice.

The canonical repository is
[`engramai-co/trading-max`](https://github.com/engramai-co/trading-max).
Protected `main` accepts only owner-authorized pull requests with green CI and
Security checks.

## V1 at a glance

- responsive Next.js dashboard and FastAPI control plane;
- read-only Trading 212 Invest and Stocks ISA ingestion;
- immutable snapshots, cash-flow-aware performance, ETF look-through, and GICS
  classification;
- per-ticker technical, valuation, fundamentals, estimates, financials,
  options, and research-ledger lenses;
- durable refresh jobs, health/readiness views, backups, and safe restore;
- OS credential-store-backed Trading 212, OpenCode, and DeepSeek settings;
- local foreground operation plus an optional per-user macOS service.

```text
Browser ──> Next.js BFF ──> FastAPI ──> durable worker
                              │               │
                              ├── SQLite      ├── Trading 212
                              ├── snapshots   ├── market research
                              └── artifacts   └── optional LLM providers
```

State and credentials stay outside the Git checkout. Failed refreshes never
replace the last valid immutable snapshot, and the product never places trades.

## Install locally

Clone the repository, open the checkout in Codex, and give it one setup request:

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
```

```text
Set this project up completely for local use.
```

The repository-scoped
[`trading-max-onboard`](.agents/skills/trading-max-onboard/SKILL.md) skill and
[`AGENTS.md`](AGENTS.md) tell Codex to perform the locked installation and
production build, initialize external state, start the app on loopback, and
verify the local processes without asking for more setup instructions.

Codex then opens the locally deployed Settings page. The user enters, tests,
and saves their own read-only Trading 212 API credentials there, never in chat.
After the first refresh completes and account totals are plausible, setup is
finished. An external LLM key is optional and is not required to start using
the deterministic product path.

For a guided manual installation:

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
uv run --package trading-max-backend trading-max onboard
```

Requirements and platform support are documented in the
[local installation guide](docs/installation/local-installation.md). macOS is
the first-class V1 target; Linux desktop requires a Secret Service-compatible
keyring. Windows and unattended headless Linux are not production-supported in
V1.

## Local development

```bash
uv sync --all-packages --group dev --frozen
npm --prefix apps/web ci --no-audit --no-fund

npm run dev:api
PORTFOLIO_BACKEND_URL=http://127.0.0.1:8421 npm run dev
```

Use a synthetic external state root for development. Never point tests or
manual development commands at production state.

## Repository layout

| Path | Responsibility |
|---|---|
| `apps/web` | Next.js interface and server-side backend proxy |
| `services/api` | FastAPI routes, settings, projections, and schedulers |
| `backend` | Domain, ingestion, analytics, research, storage, and worker |
| `contracts` | Generated OpenAPI contract consumed by the frontend |
| `deploy/local` | Supported local workstation runtime |
| `deploy/macos` | Advanced operator-managed macOS service profile |
| `docs` | Architecture, installation, and local operations |

## Documentation

- [System overview](docs/architecture/system-overview.md)
- [API and contract guide](docs/api/README.md)
- [Local installation](docs/installation/local-installation.md)
- [Coding-agent onboarding](docs/operations/agent-local-deployment-runbook.md)
- [Interface-lens architecture](docs/architecture/interface-lenses.md)
- [Security Master and GICS](docs/architecture/security-master-and-gics.md)
- [LLM synthesis](docs/architecture/llm-synthesis.md)
- [Contributing and release checks](CONTRIBUTING.md)
- [Provider and data-source notices](THIRD_PARTY_NOTICES.md)

Project policy is defined in [SECURITY.md](SECURITY.md),
[PRIVACY.md](PRIVACY.md), [SUPPORT.md](SUPPORT.md),
and [TRADEMARKS.md](TRADEMARKS.md).

## Scope boundary

V1 does not provide brokerage order placement, public-internet hosting,
multi-user authentication, tenancy, or a hosted service. This repository does
not contain user credentials, account data, provider downloads, or remote-host
configuration. Local installations run in the foreground or as explicitly
configured user-managed services.

Trading Max stays local-first, read-only, explainable, and recoverable. Current
work focuses on first-run reliability, backup visibility, update provenance,
and broader synthetic end-to-end coverage. Automated trading, invented values
for missing data, and unsupported provider integrations remain explicit
non-goals. Feature proposals should explain user value, data provenance,
privacy impact, failure behaviour, and ongoing maintenance cost.

## Providers, data, and affiliation

Trading Max contains independently written adapters for the official Trading
212 Public API and optional third-party research providers. It depends on the
open-source `yfinance` package but does not copy, bundle, or redistribute Yahoo
Finance market data. It does not ship broker data, portfolio snapshots, cached
provider responses, company logos, or model output.

Provider access remains subject to each provider's terms and the permissions
selected by the local user. Trading Max is not affiliated with or endorsed by
Trading 212, Yahoo, Bloomberg/OpenFIGI, any ETF issuer, or any model provider.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete source and
attribution matrix.

## Licence

Trading Max source code is available under the
[Apache License 2.0](LICENSE). The licence does not grant permission to use the
Trading Max or Engram names or marks to imply endorsement; see
[TRADEMARKS.md](TRADEMARKS.md).
