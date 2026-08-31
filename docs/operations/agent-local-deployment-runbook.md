# Agent runbook: deploy Trading Max on a local workstation

This runbook is written for a coding agent operating a user's computer. It is
deliberately conservative because Trading Max handles financial data and API
credentials.

## Activation

Follow this runbook whenever the user opens an already-cloned Trading Max
checkout and asks an agent to install, onboard, set up, run, or locally deploy
it. That request includes the full safe foreground installation; load the
repository instructions and `trading-max-onboard` skill and continue without
asking for a second setup prompt. On a fresh checkout with no existing state or
occupied ports, proceed immediately through preflight and installation. Do not
turn the request into a tutorial or ask the user to execute commands the agent
can safely execute itself.

Pause only at the explicit boundaries in this document: existing state with
unclear ownership, occupied ports, unavailable credential storage, material
broker reconciliation differences, network exposure, or background-service
installation.

## Objective

Install and verify a single-user Trading Max instance with:

- API bound to `127.0.0.1:8421`;
- web bound to `127.0.0.1:3413`;
- durable worker running;
- state outside the Git checkout;
- secrets stored only by the operating-system credential manager;
- no public network exposure.

## Non-negotiable rules

1. Never ask the user to paste Trading 212 or LLM secrets into chat, shell
   history, a committed file, logs, or screenshots.
2. Never bind the API or web process to `0.0.0.0`.
3. Never delete, overwrite, migrate, or initialize an existing state root
   without first identifying it and obtaining explicit user approval.
4. Prefer `doctor` for an existing installation. Current `setup` is
   non-destructive and may fill missing defaults, but it is not a repair for
   provider, queue, or snapshot failures.
5. Never claim the deployment is healthy based only on process state or a web
   HTTP 200. `/ready` and the first immutable snapshot are the acceptance gate.
6. Never configure Tailscale, a reverse proxy, login items, launchd, systemd,
   or Windows Services unless the user separately authorizes that scope.
7. Never work around an unavailable OS keyring by writing plaintext secrets.

## Phase 0: establish scope from the workstation

Inspect and infer:

- repository URL or existing checkout;
- target platform and operating-system version;
- interactive foreground run or an explicitly authorized long-running service;
- default or custom external state root;
- whether this is a fresh install or an upgrade.

Use the platform default and a foreground process unless the user already
specified otherwise. If a choice would change where existing state is stored
or how the host starts at login, pause for user confirmation.

## Phase 1: preflight

Run read-only checks:

```bash
git --version
uv --version
python3 --version
node --version
npm --version
lsof -nP -iTCP:3413 -sTCP:LISTEN || true
lsof -nP -iTCP:8421 -sTCP:LISTEN || true
```

If a required tool is missing, prefer the user's existing package manager and
the vendor's documented package. Explain the installation before changing the
system. Do not pipe a remote script directly into a shell, and do not silently
replace an existing Python or Node installation.

Acceptance:

- Python 3.12 is installable through uv;
- Node is 22 LTS, or at least 20.19;
- ports are free or belong to an instance the user explicitly wants stopped.

Do not silently kill an existing process.

## Phase 2: inspect before initializing

Determine the platform default:

- macOS: `~/Library/Application Support/Trading Max`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/trading-max`
- Windows: `%APPDATA%\Trading Max`

Check for these paths without printing file contents:

```text
<state-root>/secrets/trading_max.env
<state-root>/trading_max.db
<state-root>/latest.json
```

Decision:

- If any exists, classify this as an **existing installation**. Run `doctor`
  first; setup is unnecessary unless a reviewed bootstrap key is missing.
- If none exists, classify it as a **fresh installation** and continue.

## Phase 3: acquire and verify source

For a new checkout:

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
git status --short
git rev-parse HEAD
```

For an existing checkout:

```bash
git status --short
git remote -v
git rev-parse HEAD
```

The checkout must have an `origin` or `upstream` remote pointing to
`engramai-co/trading-max`.

If the worktree is dirty, do not pull or switch revisions until the user
confirms how those changes should be handled. For a clean existing checkout,
refresh the canonical references and require a fast-forward update before
onboarding:

```bash
git fetch --prune origin main --tags
git pull --ff-only origin main
```

Protected public `main` is the supported onboarding source. For an explicitly
requested public release tag or contributor branch, record the full commit SHA
and do not describe it as current `main`.

## Phase 4: run non-interactive onboarding

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-service \
  --no-browser
```

This is the default agent path. For an explicitly authorized macOS login
service, replace `--skip-service` with `--install-service`. For a custom state
root:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-service \
  --no-browser \
  --state-root "/absolute/path"
```

The command performs locked dependency installation, production build,
idempotent state initialization, migration, and local API verification. It
never asks an agent for secrets and has no credential command-line flags.

Verify, without printing the bootstrap or token:

- bootstrap file exists;
- permissions are `0600` on POSIX;
- database exists;
- `doctor` reports the latest migration;
- state root is outside the checkout.

For a read-only check of an existing installation, run:

```bash
uv run --package trading-max-backend trading-max doctor --check-updates
```

or the corresponding explicit `--state-root`.

## Phase 5: start interactively

```bash
deploy/local/start.sh
```

Keep this process attached to a terminal/session that can be stopped cleanly.
The script owns API, worker, and web child processes and handles `Ctrl-C`.

## Phase 6: pre-data smoke

In another terminal:

```bash
curl -sS -o /tmp/trading-max-health.json \
  -w 'health_http=%{http_code}\n' \
  http://127.0.0.1:8421/health
curl -sS -o /tmp/trading-max-ready.json \
  -w 'ready_http=%{http_code}\n' \
  http://127.0.0.1:8421/ready
curl -sS -o /dev/null -w 'web_http=%{http_code}\n' \
  http://127.0.0.1:3413/
```

Expected on a fresh install:

- `web_http=200`;
- health contains a healthy worker heartbeat;
- readiness may be non-200 with `no typed snapshot has been published`.

This is a **running but not data-ready** state.

## Phase 7: credential handoff

Tell the user to open:

```text
http://127.0.0.1:3413/settings
```

The user enters secrets directly into the local Settings UI. The agent may
explain fields and observe redacted connection status, but must not read,
transcribe, echo, screenshot, or store the credentials.

Before credential handoff, confirm that a custom state root's bootstrap file
contains `TRADING_MAX_CREDENTIAL_SERVICE` and that it is not the bare historic
`com.engram.trading-max.credentials` service. Never reuse a bootstrap file from
another installation. This is an identity-isolation gate, not an optional
configuration preference.

Require connection testing before save. Trading 212 Invest and Stocks ISA may
use separate keys; each key must be read-only. The existing Yahoo
Finance-compatible research adapter requires no credential and remains part of
the private V1 data path.

## Phase 8: first refresh

After the user confirms at least one broker profile is connected:

1. use **Refresh now** in the UI;
2. open **Health**;
3. wait for the durable job to reach a terminal state;
   the first broker sync may take several minutes because Trading 212 limits
   each history report to one year and Trading Max backfills older annual
   slices until every current position has a verified opening ledger;
4. if it fails, report the exact failed stage and preserve the last valid
   snapshot;
5. do not repeatedly retry an authentication or reconciliation failure.

If account NAV reconstruction reports missing dated cash events, check whether
the user has used Trading 212 Card. The public API does not return merchant card
payments. Explain that the current broker value remains authoritative, but
historic TWR and risk ratios stay unavailable until the user supplies a manual
Trading 212 history export containing the `Card debit` rows. Never hide the gap
with a synthetic opening balance or a terminal cash adjustment.

## Phase 9: acceptance

Run:

```bash
curl -fsS http://127.0.0.1:8421/health
curl -fsS http://127.0.0.1:8421/ready
curl -fsS http://127.0.0.1:8421/v1/snapshots/latest
curl -fsS http://127.0.0.1:3413/ >/dev/null
```

The deployment is accepted only when:

- `/health` is `ok`;
- `/ready` is `ready`;
- worker heartbeat is healthy;
- queue has no active failed installation job;
- latest snapshot identifier is non-empty;
- web root is HTTP 200;
- no process listens on a non-loopback address;
- the user confirms native account totals are plausible.

## Phase 10: optional macOS service installation

Only after interactive acceptance and explicit approval to change login
startup behaviour:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-build \
  --install-service \
  --no-browser
```

Verify the API, worker, web, and backup LaunchAgents are loaded. To remove the
services without deleting state:

```bash
uv run python deploy/local/install-macos-service.py uninstall
```

Do not install this macOS service path on Linux or Windows.

## Phase 11: backup verification

For foreground or non-macOS installations, create one explicit backup:

```bash
uv run --package trading-max-backend trading-max backup \
  --state-root "/absolute/state/root" \
  --destination "/absolute/backup/root" \
  --retain 14
```

Record the archive path and verification success, never its contents.

## Phase 12: handoff

Report:

- full source commit SHA or release tag;
- platform and versions;
- state-root path, without listing account files;
- process model (`foreground`, `launchd`, etc.);
- health/readiness result;
- latest snapshot ID and data-as-of date;
- whether LLM is fake or external, without revealing a key;
- backup status;
- known limitations and exact stop command.

For the foreground launcher, the stop command is `Ctrl-C` in its terminal.

## Failure boundaries

Stop and ask the user when:

- an existing state root is found but its ownership or intended use is unclear;
- the checkout contains uncommitted changes;
- OS credential storage is unavailable;
- a migration or reconciliation fails;
- account totals differ materially from the broker;
- the requested setup requires LAN/public access or multi-user auth;
- a background service installation would change login/startup behavior.

## Current known limitations

- Generic local installation does not install an automatic updater.
- The advanced unattended profile under `deploy/macos` is outside this
  runbook and must not be applied to an unprovisioned workstation.
- macOS has a per-user service installer; it still requires a terminal-based
  source install before registration.
- Linux does not ship a systemd unit and Windows does not ship a Service.
- Linux systemd and Windows Service definitions are not shipped.
- A fresh installation is not ready until the first broker-backed immutable
  snapshot is published.
