---
name: trading-max-onboard
description: Install and verify an already-cloned Trading Max checkout for local use, or diagnose and resume an existing local installation. Use for local setup, onboarding, or launch requests; not ordinary development, cloning alone, CI, or remote production deployment.
---

> **Archived on 2026-09-22.** This is the former source/agent onboarding workflow, retained for existing installations. It is no longer the primary onboarding entry or an active agent skill. See the [current desktop onboarding guide](../../../installation/desktop-onboarding.md) and [archive status](../README.md).

# Trading Max local onboarding

Own the installation through a broker-backed ready snapshot. A request to set
up this cloned checkout authorizes the safe foreground workflow; do not turn
it into a command-list tutorial or ask for a second setup prompt.

## Route the request first

Read the repository's
[agent deployment runbook](../agent-local-deployment-runbook.md)
completely before changing the workstation. Resolve paths from the checkout
root. Use it as the procedure; use this skill for scope and acceptance.

- **Fresh workstation:** verify source, toolchain, ports and external state;
  onboard, start foreground services, hand off credential entry, and verify the
  first full refresh.
- **Existing local installation:** inspect its state root, process owner and
  redacted status; run `trading-max doctor --check-updates`. Reuse the known
  installation. Use the runbook's update path only when an update is requested.
- **Provisioned remote host:** use the operator procedure in
  [deploy/macos](../../../../deploy/macos/README.md); this skill does not authorize
  or perform a production upgrade.

## Installation contract

1. Verify the canonical `engramai-co/trading-max` source and record the branch,
   commit and `VERSION`. Use the verified canonical remote, which may be
   `upstream` instead of `origin`. Default fresh onboarding to clean `main`
   and fast-forward it; preserve dirty/diverged work and any explicitly selected
   release or contributor branch.
2. Use Python 3.12 and Node 22 LTS. Inspect loopback ports `3413`/`8421`, the
   intended external state root and OS credential storage before initialization.
   Diagnose collisions or ambiguous ownership before replacing anything.
3. For a fresh installation run, from the repository root:

   ```bash
   uv run --package trading-max-backend trading-max onboard \
     --non-interactive \
     --skip-service \
     --no-browser
   deploy/local/start.sh
   ```

   For a custom state root, export `TRADING_MAX_STATE_ROOT` before **both**
   commands and keep it for subsequent launches. Onboarding with `--skip-service`
   does not leave the application running; the foreground launcher is required.
4. Open `http://127.0.0.1:3413/settings`. The user enters, tests and saves
   read-only Trading 212 credentials directly. Never collect, transcribe, print,
   screenshot or put provider secrets in chat, command arguments or files.
5. Yahoo Finance-compatible data remains the default. Alpaca is an optional
   reconstruction enhancement configured in Settings; it is not required for
   onboarding and does not replace broker records or all research data. AI
   analysis is optional too. Both follow the same direct-entry secret boundary.
6. Follow one full refresh in Health through completion; reuse a matching job
   already queued by onboarding instead of submitting duplicates. Check JSON
   readiness, worker health, the immutable snapshot and broker totals. HTTP 200
   or the CLI's “Onboarding complete” message alone does not establish readiness.
7. Inspect **Settings → Update schedule** separately from process startup.
   Fresh local bootstrap disables scheduled collection; a foreground session
   cannot collect records while stopped. Do not promise complete historical
   intraday coverage or enable background startup without authorization.

Existing task authorization carries forward. Ask only when a required choice or
permission remains unresolved: ambiguous state/process ownership, unavailable
credential storage, material reconciliation differences, network exposure or
login-service installation. Keep ordinary onboarding on loopback; use no
plaintext secret fallback. Do not reset existing state to repair a failed job.

## Completion

Report version and full source revision, canonical/update status, external state
root, foreground/service process model, health and JSON readiness, snapshot date,
redacted provider and schedule status, backup verification, and exact stop/restart
actions. If waiting on credential entry or broker-total confirmation, report
that concrete remaining step instead of calling the installation complete.
