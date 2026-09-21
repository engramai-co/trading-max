# Trading Max documentation

Start with the task you want to complete. The product guides describe the
current 1.x workspace; architecture pages describe its calculation and runtime
contracts.

## Use Trading Max

- [Install and connect accounts](installation/local-installation.md) — supported
  platforms, first refresh, services, updates, backups, and recovery.
- [Understand your portfolio](guides/portfolio.md) — account scope, holdings,
  look-through, money and P&L, return comparison, and review.
- [Research a security](guides/research.md) — financials, price charts,
  expectations, valuation scenarios, options, and the journal.
- [Understand the numbers](guides/data-and-metrics.md) — currencies, cash flows,
  return denominators, source coverage, and model limitations.
- [Get help](../SUPPORT.md), [privacy](../PRIVACY.md), and
  [security reporting](../SECURITY.md).

## Develop and integrate

- [Contributing and release checks](../CONTRIBUTING.md)
- [System overview](architecture/system-overview.md) and
  [repository layout and ownership](architecture/repository-layout.md)
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
- [Agent-owned local installation and diagnosis](operations/agent-local-deployment-runbook.md)
  — the [onboarding skill](../.agents/skills/trading-max-onboard/SKILL.md),
  existing-state triage, JSON readiness, optional providers and first refresh.
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
