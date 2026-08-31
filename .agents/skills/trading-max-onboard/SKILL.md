---
name: trading-max-onboard
description: Own the safe local installation and verification of an already-cloned Trading Max checkout when the user asks to set it up, install it, onboard it, run it, or deploy it locally. Use on a new user's workstation; do not use for cloning alone, ordinary development, CI, or remote production deployment.
---

# Trading Max local onboarding

Take ownership of the local installation. Do not answer with a command list when
the safe steps can be performed directly.

## Setup request contract

The repository has already been cloned and opened in Codex. A request such as
"set this project up completely" is the complete safe foreground-onboarding
request. Do not respond with a tutorial or ask the user for a second setup
prompt. Proceed through:

1. workstation and checkout preflight;
2. dependency installation and production build;
3. external-state initialization;
4. foreground API, worker, and web launch;
5. local Settings handoff for the user's own Trading 212 credentials;
6. first refresh and final readiness verification after the user confirms the
   credentials were tested and saved.

The setup request applies only to this checkout and local workstation. It does
not authorize network exposure, remote production deployment, background
services, deletion, replacement of existing state, or access to credentials.

## Required procedure

Read `docs/operations/agent-local-deployment-runbook.md` completely, then follow
it as the source of truth. In particular:

- accept the canonical `engramai-co/trading-max` repository as `origin` or
  `upstream`, preserve a dirty worktree, and fast-forward clean protected
  `main` before installation;
- inspect the platform, supported toolchain, ports `3413` and `8421`, Git
  revision, worktree, and platform-default external state root before writing;
- classify the machine as a fresh or existing installation without reading or
  printing secret contents;
- stop on ambiguous existing state or occupied ports instead of replacing
  either;
- on a fresh checkout, use the repository-supported non-interactive path:

  ```bash
  uv run --package trading-max-backend trading-max onboard \
    --non-interactive \
    --skip-service \
    --no-browser
  ```

- start the supported foreground process with `deploy/local/start.sh` and keep
  API and web listeners on loopback;
- never request, transcribe, reveal, screenshot, log, or store Trading 212 or
  model-provider credentials;
- once the application is running, open
  `http://127.0.0.1:3413/settings` in the user's local browser and pause only
  while the user enters, tests, and saves the read-only Trading 212 credentials
  for the account profiles they use;
- do not require an external LLM credential for onboarding; the deterministic
  local provider keeps that path optional;
- do not install a login/background service unless the user separately approves
  that change;
- after the user confirms a broker profile is connected, run one full refresh
  and accept the installation only after the runbook's health, readiness,
  immutable-snapshot, listener, and broker-total checks pass;
- run `trading-max doctor --check-updates` before handoff.

## Completion

Report the canonical-source and update status, source revision, external
state-root path, foreground/background process model, health and readiness,
latest snapshot date, redacted provider status, and exact stop or restart
action. A running web page without a ready broker-backed snapshot is not a
completed installation.
