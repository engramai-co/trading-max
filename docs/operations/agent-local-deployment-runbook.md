# Agent runbook: local installation and diagnosis

Use this runbook with the repository's
[onboarding skill](../../.agents/skills/trading-max-onboard/SKILL.md) when a user
asks to install or run an already-cloned checkout. A setup request covers the
safe foreground workflow through verification; do not ask for a second setup
prompt. Reuse authorization already given in the task.

For an existing local installation, diagnose and resume it before considering
initialization. For a requested update, use the
[local update procedure](../installation/local-installation.md#updates).
A provisioned remote macOS host uses the separate
[operator deployment procedure](../../deploy/macos/README.md).

## 1. Inspect the workstation and existing installation

Record the platform, current source branch and commit, `VERSION`, intended state
root, process owner, and whether the user requested foreground or login startup.
Use Python 3.12, uv and Node 22 LTS. The web package declares a minimum of Node
20.19, but CI and the advanced macOS deployer use Node 22. Do not replace an
existing global runtime silently.

On macOS or Linux, inspect:

```bash
git --version
uv --version
python3 --version
node --version
npm --version
git status --short --branch
git rev-parse HEAD
cat VERSION
lsof -nP -iTCP:3413 -sTCP:LISTEN || true
lsof -nP -iTCP:8421 -sTCP:LISTEN || true
```

These shell launch recipes support macOS and Linux desktop. Windows remains a
preview; there is no packaged PowerShell launcher or Windows Service. Use
platform-appropriate diagnostics rather than presenting Bash commands as a
verified native Windows installation.

Resolve `TRADING_MAX_STATE_ROOT` or an explicitly requested custom root before
falling back to:

| Platform | Default external state root |
|---|---|
| macOS | `~/Library/Application Support/Trading Max` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/trading-max` |
| Windows | `%APPDATA%\Trading Max` |

Check existence and permissions of `secrets/trading_max.env`, `trading_max.db`
and `latest.json` without displaying contents. Any existing files, or an
unexplained non-empty directory, require identifying the installation first.
Inspect only needed non-secret bootstrap fields; never dump the env file,
which includes internal authentication tokens.

- **Fresh:** no existing state or conflicting listener; continue to setup.
- **Known existing local installation:** run `doctor`, inspect Health and
  Settings, and reuse it. A stopped app does not need a new state root.
- **Unclear ownership or occupied ports:** identify the process/state before
  any replacement. Ask only if ownership or authorization remains unresolved.
- **Advanced host:** do not run local setup against its state or services.

`doctor` is a read-only configuration/source diagnostic. It does not start
services, migrate the database, unlock the keyring, test provider credentials,
or establish runtime readiness. An update-check difference also does not prove
that a running installation is unhealthy.

```bash
uv run --package trading-max-backend trading-max doctor --check-updates
```

Use the same explicit `--state-root` or exported state-root variable throughout.
Check available disk space for dependencies, the growing state and a separate
backup; there is no fixed 2 GB lifetime storage bound.

## 2. Verify and select source

Verify a remote points to `engramai-co/trading-max` on GitHub. Inspect URLs
without copying embedded credentials into logs or chat. The canonical remote
may be `upstream` while `origin` is a fork; never assume its name.

Preserve dirty work or divergent commits before changing branches. For a fresh
installation the default is clean protected `main`; do not merge main into the
currently selected feature branch. After verification, use the matching remote:

```bash
canonical_remote=origin # use upstream instead when that is the verified remote
git fetch --prune "$canonical_remote" main --tags
git switch --no-overwrite-ignore main
git merge --ff-only "$canonical_remote/main"
git rev-parse HEAD
```

If local `main` does not exist, create it tracking the verified remote's main.
If it is checked out elsewhere or cannot fast-forward, diagnose rather than
forcing a reset. Honor an explicitly requested release tag or contributor
branch and record its full SHA; do not call it current main. Onboarding rejects
a dirty checkout, so preserve work in an agreed backup/branch or separate clean
checkout before invoking it.

## 3. Initialize a fresh installation

For a custom state root, export it before onboarding **and** launching:

```bash
export TRADING_MAX_STATE_ROOT="/absolute/path/to/trading-max-state"
```

Omit that export for the platform default. Keep state outside the checkout and
never copy another installation's bootstrap file or credential namespace.

From the repository root:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-service \
  --no-browser
```

This initializes external state and migrations, installs locked dependencies,
builds the web app, and checks a temporary local API. It accepts no credential
flags. The temporary API stops when the command ends; “Onboarding complete”
does not mean the web app and worker are running or that broker data is ready.

Verify the bootstrap exists with mode `0600` on POSIX, the database exists, and
`doctor` reports the expected migration. A custom root needs its own credential
namespace rather than the historic default service. No plaintext fallback is
allowed if OS credential storage is unavailable.

## 4. Launch and inspect pre-data status

```bash
deploy/local/start.sh
```

Keep the launcher attached to a terminal. It runs API, worker and web children;
`Ctrl-C` stops them. Both listeners must stay on `127.0.0.1` at ports `8421`
and `3413`. Do not configure network exposure or a login service as a side effect
of foreground setup.

From another terminal:

```bash
curl -fsS http://127.0.0.1:8421/health
curl -fsS http://127.0.0.1:8421/ready
curl -fsS http://127.0.0.1:3413/ >/dev/null
```

**Read the JSON status, not just the HTTP status code.** Both health routes can
return HTTP 200 before the first snapshot. Initially `/health` normally has
`status: degraded` and `/ready` has `status: not_ready`. The worker should have
a healthy heartbeat. Settings can be usable while portfolio data is not ready.
Inspect `bootstrapError` and worker status if startup remains unhealthy.

## 5. Connect accounts and optional providers

Open `http://127.0.0.1:3413/settings` in the user's local browser. The user enters,
tests and saves credentials directly. Observe only redacted connection status;
never read, transcribe, screenshot, log or store their secrets in chat or files.

- **Accounts & data:** connect read-only Trading 212 Invest and/or Stocks ISA
  profiles. Keep them distinct and test before saving.
- **Reconstruction market data:** Yahoo Finance-compatible data is the default.
  Alpaca is optional, disabled until enabled, and configured through this Settings
  panel rather than the CLI wizard. It supplements supported US reconstruction
  history; it does not replace broker observations, UK/FX data or company research.
  See [data sources and limits](../guides/data-and-metrics.md#optional-alpaca-reconstruction-enhancement).
- **AI analysis:** optional provider/model routes. Keep the deterministic local
  provider when the user has not requested external model setup.

## 6. Follow the first full refresh

After a broker profile is connected, inspect Data status for a matching active or
successful initial refresh. Interactive onboarding may already queue one when
it both connects a broker and installs services. Otherwise choose **Start
update** once and follow that job to a terminal state.

The first broker sync can take several minutes: annual report slices backfill
an opening ledger, and research/look-through coverage grows incrementally.
Do not repeatedly submit refreshes while a job is active. If it fails, report
the failed stage and preserve the last valid snapshot; do not retry an
unchanged authentication or reconciliation error in a loop.

Missing Trading 212 Card merchant cash events can prevent complete historical
returns even when current broker totals are available. Use the
[ingestion guidance](../architecture/trading212-ingestion.md) and request a
manual history export when relevant. Do not fabricate a balancing cash flow.

## 7. Accept the installation

Require all of:

- `/health` JSON `status` is `ok`;
- `/ready` JSON `status` is `ready`, with no bootstrap error and a healthy worker;
- the initial full-refresh job succeeded and the latest snapshot ID is non-empty;
- `/v1/snapshots/latest` returns a valid immutable manifest;
- web routes `/`, `/settings`, `/health`, `/holdings`, `/analytics`, `/research`
  and `/review` load, with no non-loopback listeners;
- the user confirms native broker totals are plausible.

Historical failed jobs can remain in the queue's counts. Diagnose the current
installation job and latest state rather than requiring the lifetime failed
count to be zero. Broker credentials and snapshot contents are not acceptance
report attachments.

Run `trading-max doctor --check-updates` again. If only the canonical commit has
advanced during setup or a requested tag differs from main, report that source
status separately from readiness.

## 8. Explain collection and optional login startup

In **Settings → Update schedule**, inspect account/intraday, performance, and
research/reconciliation schedules. Fresh local bootstrap starts scheduled
collection disabled. A foreground process collects nothing after its terminal
closes, and missed live observations cannot be recovered as broker records.
New default intraday retention is 210 days; existing explicit shorter settings
survive upgrades. Reconstructed history remains subject to source coverage.

For an explicitly authorized macOS login service, stop the foreground launcher
first and verify its ports are free, then register the existing accepted build:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-build \
  --install-service \
  --no-browser
```

Preserve a custom `TRADING_MAX_STATE_ROOT` here too. This installer verifies the
Git root, including linked worktrees. Keep the checkout at a stable path and
verify that launchd uses the selected Node/npm runtime; an interactive
version-manager shell alone does not prove service startup. Verify all four `com.engram.trading-max.local.*` LaunchAgents and
repeat readiness checks. The advanced `deploy/macos` profile has different
service names and deployment ownership; do not mix installers.

To remove local login services while keeping state:

```bash
uv run python deploy/local/install-macos-service.py uninstall
```

No systemd unit or Windows Service is shipped. Respect existing authorization;
ask about login startup only if it has not been granted.

## 9. Backup and handoff

Verify an initial credential-free backup outside the state root:

```bash
uv run --package trading-max-backend trading-max backup \
  --destination "/absolute/path/to/backups" \
  --retain 14
```

The optional local macOS service schedules backups at 03:15; registration alone
does not prove the first archive exists. See
[backup and recovery](../installation/local-installation.md#backup-and-recovery).
Report the verified archive path, never its contents.

Report version, branch/full commit, canonical/update status, state root, runtime
model, JSON health/readiness, snapshot ID/data-as-of date, redacted connections,
schedule settings, backup verification and exact stop/restart actions. If the
user still needs to enter credentials or confirm totals, state that remaining
step. A web page or a healthy `doctor` result alone is not a completed installation.
