# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Trading Max is an open-source product intended to serve users beyond its
original author. V1 supports one private user per installation.

Users need to understand their investment accounts without surrendering
control of brokerage credentials or accepting opaque, invented analysis.

## Product Purpose

Trading Max gives users an accurate, unified view of their investment accounts
and explains how those accounts arrived at their current state. Product work
must follow this durable priority order:

1. show the current account state clearly;
2. reconstruct and explain why an account won or lost;
3. support investment decisions and timely alerts.

Success means that a user can see what they own and what it is worth, separate
cash flows from investment results, review the evidence behind gains and
losses, and use research or model interpretation without losing the underlying
accounting truth.

## Positioning

Trading Max is local-first, read-only portfolio intelligence built around an
auditable evidence chain. It combines broker-native account values, historical
reconstruction, deterministic portfolio analytics, account review, research,
and optional model interpretation in one system. Models may explain computed
facts but may not originate transactions, balances, prices, holdings, or base
metrics.

## Operating Context

- The product is a responsive bilingual web application used on desktop and
  mobile browsers.
- Each V1 installation is private and single-user. A deployment may run on a
  local workstation or a privately operated Mac; no production host is part of
  the source distribution.
- Invest and Stocks ISA data use the read-only Trading 212 API path.
- CFD data uses manually imported Trading 212 CSV exports and may become stale.
- Users review current accounts in the dashboard, inspect portfolio performance
  and risk, open dedicated account-history reviews, conduct investment research,
  manage integrations and schedules, and monitor system health.
- Scheduled and manual refreshes publish immutable snapshots; a failed refresh
  must not replace the last valid snapshot.

## Capabilities and Constraints

- Trading Max never places trades and is not an execution interface.
- Missing or incomplete data must remain visibly unavailable or partial; it
  must never be converted into a plausible-looking zero or synthetic fact.
- All monetary values, ratios, stage boundaries, rankings, attribution, and
  counterfactual results come from versioned deterministic code.
- Every material conclusion must remain traceable to its data coverage,
  calculation version, stable lens, warnings, and supporting evidence.
- Invest, Stocks ISA, and CFD retain distinct economic semantics. Invest and
  ISA may have reconstructed NAV and TWR; CFD uses an imported realised
  cash-equity proxy and never fabricates broker NAV, MTM, or TWR.
- Account transfers must be distinguished from household external cash flows.
- Credentials, runtime state, broker exports, snapshots, generated research,
  and backups stay outside Git. Secrets remain in the operating-system
  credential store.
- The deterministic product remains complete and usable when no model provider
  is configured.
- Chinese and English are first-class product languages.
- V1 does not provide multi-user tenancy or public-internet hosting.
- The Apache-2.0 source licence does not grant rights to provider data or
  third-party marks. Provider terms and data-redistribution boundaries remain
  the local user's responsibility.

## Brand Commitments

The product name is **Trading Max**, a company project using the existing
Trading Max / Portfolio Intelligence identity. Existing brand assets are the
authority and live under `apps/web/public/brand/`. Product language is direct,
precise, bilingual, and explicit about uncertainty; it must not use polished
copy to conceal missing evidence or degraded data quality.

## Evidence on Hand

- The working product, generated API contract, deterministic analytics, tests,
  and deployment gates in this repository.
- Existing Trading Max marks and lockups in `apps/web/public/brand/`.
- The account-review scope and accounting decisions in
  `docs/architecture/performance-metrics.md` and
  `docs/architecture/trading212-ingestion.md`.
- Architecture records covering Trading 212 ingestion, performance metrics,
  interface lenses, research, security, durable jobs, and production gates in
  `docs/architecture/` and `docs/operations/`.
- Real account data and broker exports exist only in private external state and
  are not product assets that may be copied into source, fixtures, screenshots,
  or public demonstrations.
- No testimonials, public customer claims, or performance promises are
  established; future work must not fabricate them.

## Product Principles

1. **State before story.** Current account truth is more important than
   commentary, predictions, or decorative analytics.
2. **Reconstruct before advising.** Explain the money, phases, attribution, and
   risk before offering decision support or alerts.
3. **Evidence before fluency.** Deterministic, versioned facts govern every
   model explanation.
4. **Honest degradation over false completeness.** Preserve warnings,
   staleness, unavailable metrics, and account-specific limitations.
5. **Private control by default.** Keep financial data and credentials under
   the user's control while preserving a path to legally reviewed public or
   commercial distribution.

## Accessibility & Inclusion

The product must remain responsive, keyboard-operable, and understandable
without relying on color alone. Visible focus, reduced-motion support,
text-backed statuses, accessible tables and accordions, and complete Chinese
and English coverage are durable interface requirements.
