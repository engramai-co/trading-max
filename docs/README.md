# Trading Max documentation

Start with the task you want to complete. The product guides describe the
current 1.x workspace; architecture pages describe its calculation and runtime
contracts.

## Use Trading Max

- [Desktop onboarding](installation/desktop-onboarding.md) — current App capabilities,
  workspace entry, existing-server connection and the next enrollment step.
- [Understand your portfolio](guides/portfolio.md) — account scope, holdings,
  look-through, money and P&L, return comparison, and review.
- [Research a security](guides/research.md) — financials, price charts,
  expectations, valuation scenarios, options, and the journal.
- [ETF source coverage](guides/etf-coverage.md) — issuer discovery, complete
  holdings, missing weights and unsupported fund structures.
- [Understand the numbers](guides/data-and-metrics.md) — currencies, cash flows,
  return denominators, source coverage, and model limitations.
- [Get help](../SUPPORT.md), [privacy](../PRIVACY.md), and
  [security reporting](../SECURITY.md).

## Develop and integrate

- [Contributing and release checks](../CONTRIBUTING.md)
- [System overview](architecture/system-overview.md) and
  [repository layout and ownership](architecture/repository-layout.md)
- [Desktop build and tests](../apps/desktop/README.md) and
  [desktop runtime boundaries](architecture/desktop-preview-rfc.md)
- [API and generated contracts](api/README.md)
- [Interface lenses](architecture/interface-lenses.md) and
  [UI experience](architecture/ui-experience.md)
- [Research workspace](architecture/research-workspace.md),
  [presentation](architecture/research-presentation.md), and
  [latency boundaries](architecture/research-latency.md)
- [Valuation model](architecture/valuation-model.md) and
  [technical/options research](architecture/technical-research.md)
- [Unified NAV history](architecture/unified-nav-history.md) and
  [performance calculations](architecture/performance-metrics.md)
- [Trading 212 ingestion](architecture/trading212-ingestion.md),
  [security identity and GICS](architecture/security-master-and-gics.md), and
  [optional LLM synthesis](architecture/llm-synthesis.md)

## Operate and recover

- [Deployment profiles](../deploy/README.md)
- [Archived source/agent onboarding](archive/onboarding/README.md) — historical
  installation instructions retained for existing source deployments.
- [Advanced macOS upgrades and rollback](../deploy/macos/README.md)
- [Durable jobs and worker recovery](architecture/durable-job-runtime.md)
- [Storage maintenance and recovery copies](operations/storage-maintenance.md)
  — independent backups, bounded cleanup, format activation and capacity alerts.
- [History storage and query cache](architecture/history-storage.md) and
  [immutable object packs](architecture/immutable-object-packs.md)
  — physical formats, logical identity and recovery boundaries.
- [Space/time maintenance decision record](architecture/space-time-maintenance.md)
  — implementation map and the constraints behind the current design.
- [Broker-only development preview](operations/broker-mock-preview.md)

Public documentation and demonstration screenshots belong in the repository.
Account exports, provider caches, private journals, operational evidence, and
personal audit/tutorial artifacts do not.
