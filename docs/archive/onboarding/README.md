# Archived onboarding

Archived on **2026-09-22**, from the **1.8.0** source/agent installation flow.
The replacement direction is the [desktop onboarding flow](../../installation/desktop-onboarding.md).

These pages preserve the former workflow for existing source installations and
future migration work. They are historical references, not the default path for
new desktop users. The archived skill is outside `.agents/skills` and must not
be automatically invoked.

| Former location | Archived reference |
| --- | --- |
| `docs/installation/local-installation.md` | [Source installation, maintenance and recovery](local-installation.md) |
| `docs/operations/agent-local-deployment-runbook.md` | [Agent deployment runbook](agent-local-deployment-runbook.md) |
| `.agents/skills/trading-max-onboard/` | [Former onboarding skill](agent-skill/SKILL.md) |

## What remains supported

The `trading-max onboard`, `setup` and `doctor` commands, `deploy/local` scripts,
their tests and the existing source installations remain intact. Moving their
documentation does not remove working installation or recovery behavior. The
current desktop preview still has a synthetic local demo; real local enrollment
is the next implementation step.

## Before eventual deletion

1. Accept real create/open-workspace onboarding, first refresh, and recovery in
   the packaged App.
2. Publish a supported installation and maintenance replacement for existing
   source users; preserve backup and restore instructions outside the archive.
3. Migrate inbound documentation references and review CLI compatibility before
   retiring any executable code.

Deletion is deferred. No account data, credentials, deployment state or source
installer is removed by this archival change.
