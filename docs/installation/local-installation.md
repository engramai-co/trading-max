# Install Trading Max locally

This guide installs Trading Max on one computer for one operating-system user.
It does not require Tailscale, a cloud database, or a login. The API and web
server listen only on loopback, so other devices cannot reach them.

## Let Codex install the cloned checkout

Clone the repository and open that checkout in Codex:

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
```

Then give Codex one request:

```text
Set this project up completely for local use.
```

That is the complete foreground-setup request. Codex automatically discovers
the repository-level
[`AGENTS.md`](../../AGENTS.md) and
[`trading-max-onboard`](../../.agents/skills/trading-max-onboard/SKILL.md)
skill. They route Codex to the dedicated
[`agent-local-deployment-runbook.md`](../operations/agent-local-deployment-runbook.md)
and require it to perform every safe local installation step instead of asking
for more setup instructions.

Codex installs and builds the application, initializes external state, starts
the API, worker, and web app on loopback, verifies the processes, and opens the
local Settings page. You enter, test, and save your own read-only Trading 212
API credentials there. Secrets are never entered into Codex chat. After the
first refresh succeeds and the account totals are plausible, setup is complete.
An external model-provider credential is optional.

## Support status

| Platform | Status | Credential store | Long-running service |
|---|---|---|---|
| macOS 13+ | Supported | Login Keychain | Foreground launcher or packaged per-user launchd services |
| Linux desktop | Conditional | Secret Service-compatible keyring required | Foreground launcher |
| Headless Linux | Not yet production-supported | Must provide and verify a non-plaintext keyring backend | No packaged systemd unit |
| Windows | Preview only | Windows Credential Manager through Python keyring | No packaged Windows service |

The application is intentionally single-user and local-only. Do not expose
ports `3413` or `8421` to a LAN or the public internet.

The advanced unattended macOS profile under `deploy/macos` is not part of this
installation path. It assumes an operator has already provisioned the host and
external state.

## What you need

- Git
- Python **3.12**
- [uv](https://docs.astral.sh/uv/)
- Node.js **22 LTS** (minimum supported version: 22.19)
- npm, included with Node.js
- Free disk space for dependencies and a production build, plus growing external
  state and a separate backup; long histories can consume many gigabytes

Check the toolchain:

```bash
git --version
uv --version
node --version
npm --version
```

If `node --version` reports an odd-numbered, non-LTS release, switch to Node 22
before continuing. The lockfile can install on other versions, but that is not
the supported production baseline.

## 1. Download and onboard

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
uv run --package trading-max-backend trading-max onboard
```

The guided command:

- checks Git, uv, Node, and npm;
- installs the exact locked Python and web dependencies;
- creates the external state directory and database;
- builds the production web application;
- optionally connects Trading 212 Invest and Stocks ISA;
- optionally connects OpenAI (the default), Anthropic or Google through Pi AI;
- hides every credential entry and tests it before saving;
- saves secrets only to the operating-system credential manager;
- optionally installs the per-user macOS services;
- verifies a temporary local API; if services are installed, opens the product.

Without service installation, onboarding exits after preparation. Start the
foreground launcher in step 3; the command does not leave a worker or web app
running, and its completion message does not certify broker-data readiness.

It is safe to rerun. Existing state, bootstrap values, and integrations are
preserved unless you explicitly replace a tested credential.

The CLI deliberately has no credential flags, keeping secrets out of shell
history and process listings.

For an automation agent or unattended build:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-service \
  --no-browser
```

That safe automation mode installs and verifies the application but skips
provider credentials and login/background services. The user completes
credentials later in local Settings and may separately approve service
installation after the foreground instance is accepted.

## 2. External state

The default external state location is:

- macOS: `~/Library/Application Support/Trading Max`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/trading-max`
- Windows: `%APPDATA%\Trading Max`

The onboarding command internally uses the idempotent `setup` primitive, which
creates:

- an external SQLite database and migration ledger;
- a mode-`0600` bootstrap file containing a random internal API token;
- an installation-specific OS credential namespace for custom state roots;
- a fake LLM provider configuration so the application can start without an
  external AI key.

It does **not** create Trading 212 or LLM credentials.

`setup` is idempotent: repeating it preserves every existing bootstrap value
and only adds missing defaults. `doctor` remains the preferred read-only
diagnostic command.

`doctor` checks the bootstrap boundary, database migration ledger, canonical
source provenance, current revision, and worktree without querying provider
credentials or account records. It validates bootstrap authentication consistency and custom-root
credential isolation without querying the OS keyring. It does not check live
processes, provider connectivity or snapshot readiness; use Health and Settings
for those. An active database with a non-empty WAL may require a temporary copy
for a strictly read-only schema check. This is limited to 64 MiB; a larger or
changing database reports the schema as unverified, not corrupt. Recheck after
a normal application shutdown if needed. Add `--check-updates` to compare the local commit with public
protected `main` using a read-only remote query:

```bash
uv run --package trading-max-backend trading-max doctor --check-updates
```

The credential namespace is part of the state-root identity. Never copy a
bootstrap file from another installation, and never point two intended users
at the same state root. Separate custom state roots receive separate Keychain,
Credential Manager, or Secret Service namespaces automatically.

To use a non-default state directory, export it before onboarding and keep the
same value for launches, diagnostics, backups and service registration:

```bash
export TRADING_MAX_STATE_ROOT="/absolute/path/to/trading-max-state"
uv run --package trading-max-backend trading-max onboard
```

A one-off `--state-root` flag also works for CLI commands, but does not persist
into a later `deploy/local/start.sh` invocation.

## 3. Start Trading Max

```bash
deploy/local/start.sh
```

The launcher starts three supervised child processes in the current terminal:

1. FastAPI on `127.0.0.1:8421`;
2. the durable background worker;
3. Next.js on `127.0.0.1:3413`.

Open:

```text
http://127.0.0.1:3413
```

Keep the terminal open. Press `Ctrl-C` to stop all three processes. This
foreground launcher does not automatically restart after logout or reboot.

Logs are stored below the external state root, not in Git:

```text
<state-root>/logs/api.log
<state-root>/logs/worker.log
<state-root>/logs/web.log
```

### Keep it running after login on macOS

The interactive onboarding asks whether to install the per-user service.
After accepting a foreground installation, stop it with `Ctrl-C` before
registering login services, so both do not compete for the same ports. Keep
your custom state-root export, if any. To reuse the accepted build:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive --skip-build --install-service --no-browser
```

The installer verifies a Git checkout, including a linked worktree. Keep that
checkout at a stable path while login services reference it. The installer must
retain the selected Node/npm runtime for launchd; validate service startup rather
than relying only on an interactive version-manager shell.

This installs four `com.engram.trading-max.local.*` per-user LaunchAgents:

- API, worker, and web restart after an unexpected exit and start after login;
- a nightly 03:15 backup uses SQLite's online backup API;
- logs are written to `~/Library/Logs/Trading Max`;
- backup archives are written to `~/Backups/Trading Max`.

Remove only the services, preserving state and backups:

```bash
uv run python deploy/local/install-macos-service.py uninstall
```

## 4. Understand the first-start state

A new installation has no portfolio snapshot yet. The following state is
expected:

- the web app returns HTTP 200;
- `GET /health` reports `degraded`;
- `GET /ready` reports `not_ready`;
- Settings is usable;
- portfolio pages do not contain real account data.

This is not a process crash. Both endpoints can return **HTTP 200** in this
state; read their JSON `status` fields. Readiness requires a published snapshot,
no bootstrap error, and a healthy worker. A successful first full refresh and
broker-total confirmation are additional installation acceptance checks.

Check it without exposing a secret:

```bash
curl -fsS http://127.0.0.1:8421/health
curl -sS http://127.0.0.1:8421/ready
curl -fsSI http://127.0.0.1:3413/
```

## 5. Connect read-only data providers

The onboarding wizard can configure providers directly. If you skipped them,
open **Settings → Accounts & data** for broker connections. Optional model
providers and routes live in **Settings → Model connections**.

For each connection:

1. enter the candidate credential;
2. reveal it only if you need to verify typing;
3. select the intended model where applicable;
4. click **Test**;
5. save only after the test succeeds.

The UI clears credential fields after a successful save. Stored secrets live
in:

- macOS Login Keychain;
- Windows Credential Manager;
- Linux Secret Service/keyring backend.

The application intentionally has no plaintext secret fallback.

For Trading 212, create read-only keys with only the account/history access
needed by the application. Do not grant trading permission. Invest and Stocks
ISA use separate connection profiles.

LLM configuration is optional and supports security name resolution. Connecting
a model does not start portfolio/ticker AI analysis. Legacy synthesis requires
an explicit `TRADING_MAX_LLM_ANALYSIS_ENABLED=true` operator setting; the default
is false. Offline compatibility tests use a deterministic fake provider.

Yahoo Finance-compatible data remains the default market-data path. Optional
Alpaca keys are configured in **Accounts & data → Reconstruction market data**,
not in the CLI wizard. Choose **Test connection**, then **Save and enable** to
activate it. Use **Turn off enhancement** to disable it later. It improves
supported US historical reconstruction and retains YF
fallback; it does not promise complete overnight data or replace broker
observations. See [coverage and permissions](../guides/data-and-metrics.md#optional-alpaca-reconstruction-enhancement).

## 6. Publish the first snapshot

When onboarding installs the macOS service and configures a Trading 212
profile, it queues the first refresh automatically. Otherwise, choose
**Data status → Start update** after at least one Trading 212 profile has passed its connection
test. Check Data status first and follow an already queued initial job rather than
submitting another.

The refresh is asynchronous. Follow it from **Health**. A successful first run
must end with:

> The first Trading 212 sync can take several minutes for an older account.
> Trading Max requests history in one-year slices (the broker's per-report
> limit), consolidates and deduplicates them locally, and reuses the verified
> ledger on subsequent refreshes.

- no active failed stage;
- a healthy worker heartbeat;
- a non-empty latest snapshot/run identifier;
- `GET /ready` returning HTTP 200 and `"status": "ready"`;
- Overview showing the same native account totals as Trading 212, subject to
  documented FX/rounding reconciliation tolerances.

Do not treat an HTTP 200 web page alone as a successful installation. Historical
failed-job counts need not be zero: inspect the current job and latest snapshot.

### Collection after setup

Check **Settings → Update schedule** for account/intraday, performance, and
research/reconciliation schedules. Fresh local bootstrap starts collection
disabled; starting a process or installing login services does not enable these
preferences. Collection requires the host and worker to remain running.

New default intraday retention is 210 days. Existing explicit shorter overrides
remain unchanged during upgrades. Earlier daily-only records stay daily, and
reconstruction is limited by ledger and provider coverage. See the
[range and sampling guide](../guides/portfolio.md#read-money-and-pl).

## Updates

This procedure is for a foreground local installation. For an advanced managed
macOS host, use the [verified-SHA deployment procedure](../../deploy/macos/README.md).
Do not run a foreground launcher alongside installed login services; stop those
through their owning service manager before rebuilding.

1. Run `doctor --check-updates`, record the current revision, and preserve local
   changes. An explicitly pinned release may legitimately differ from main.
2. Stop the foreground launcher with `Ctrl-C`. Keep the same state-root export.
3. Create and verify a [backup](#backup-and-recovery) outside the state root.
4. Verify which remote points to `engramai-co/trading-max` (`origin` or `upstream`).
   On a clean main-based installation:

   ```bash
   canonical_remote=origin # use upstream if it is the verified canonical remote
   git fetch --prune "$canonical_remote" main --tags
   git switch --no-overwrite-ignore main
   git merge --ff-only "$canonical_remote/main"
   uv run --package trading-max-backend trading-max onboard \
     --non-interactive --skip-service --no-browser
   deploy/local/start.sh
   ```

   If `main` does not exist locally, create it tracking the verified remote's
   main. Stop on divergence or an occupied worktree; do not force-reset local
   work. Do not replace an explicitly selected release without choosing an
   upgrade target.
5. Re-run `doctor --check-updates`, check `/health` and `/ready` **JSON**, worker
   status and application routes, and confirm the previous snapshot is readable.

The supported onboarding command reuses bootstrap values and credentials,
applies packaged migrations, and rebuilds locked dependencies. Building the
web app alone is not a complete application update. Never delete the state root
or rotate credentials to resolve source drift. Local updates do not provide the
advanced macOS deployer's automatic rollback; retain the source revision and
verified backup until acceptance.

## Backup and recovery

Create a consistent, credential-free backup on any supported workstation:

```bash
uv run --package trading-max-backend trading-max backup \
  --destination "/absolute/path/to/backups" \
  --retain 14
```

The command uses SQLite's online backup API, excludes secrets and logs, verifies
the archive, and retains the newest requested number. Keep an off-host copy.
The optional macOS service above schedules this command nightly.
Archives exclude bootstrap tokens and provider secrets; restoring on another
installation requires its own bootstrap and re-entered credentials in Settings.

Restore remains deliberately operator-gated. Follow
[`tools/restore_backup.py`](../../tools/restore_backup.py) only after stopping
all Trading Max processes and creating a separate safety backup.

## Troubleshooting

### `doctor` says “not initialized”

If you previously chose a custom path, pass `--state-root` again or set
`TRADING_MAX_STATE_ROOT`. Repeating setup is safe but does not diagnose provider
or readiness failures; use `doctor` and Health for that.

### `doctor` reports source provenance or an available update

Confirm that `origin` or `upstream` points to
`https://github.com/engramai-co/trading-max.git`. Preserve or commit any local
work before updating, then use the fast-forward procedure above. Never replace
state or copy a bootstrap file to resolve source drift.

### Settings says the credential store is unavailable

Unlock the current desktop login session and verify that the operating system
has a supported keyring backend. On headless Linux, stop: plaintext storage is
not an approved workaround.

### Web is available but readiness is red

Open **Health** and inspect the exact failed stage. On a fresh install, “no
typed snapshot has been published” is expected until the first successful
refresh.

### Port 3413 or 8421 is already in use

Identify whether the listener belongs to the intended installation before
starting another copy. Reuse it when appropriate; otherwise stop it through its
owning terminal/service manager with authorization:

```bash
lsof -nP -iTCP:3413 -sTCP:LISTEN
lsof -nP -iTCP:8421 -sTCP:LISTEN
```

Do not solve this by changing the API host to `0.0.0.0`.

### A refresh fails

Keep the last valid snapshot. Trading Max publishes snapshots atomically, so a
failed refresh must not replace the latest successful data. Inspect Health and
the external log directory before retrying.
