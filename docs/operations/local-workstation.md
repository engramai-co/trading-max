# Local Workstation

Trading Max can run on one workstation without Tailscale and without an
account login. macOS is the supported interactive target; Linux desktop is
conditional on an available Secret Service-compatible keyring, and Windows is
preview-only. The API and web server remain bound to loopback; the
operating-system user is the security boundary.

For installation from a fresh checkout, use the
[local installation guide](../installation/local-installation.md). Coding
agents must use the
[agent deployment runbook](agent-local-deployment-runbook.md), which includes
state-preservation and acceptance gates.

## First run

From a fresh checkout with Python 3.12, uv, and Node.js 22 LTS:

```bash
uv sync --all-packages --frozen
npm --prefix apps/web ci --no-audit --no-fund
npm --prefix apps/web run build
uv run --package trading-max-backend trading-max setup
uv run --package trading-max-backend trading-max doctor
```

The command creates an external state root and a `0600` bootstrap file. It does
not create or copy any Trading 212 or LLM secret. The default provider is the
fake provider, so a clean install can be smoke-tested before credentials are
entered.

Each custom state root receives its own random operating-system credential
service namespace. Two local installations therefore cannot read one another's
broker or LLM credentials, even when they run under the same OS user. The
historical default state root keeps its original namespace for upgrade
compatibility.

For development, start the API and web processes in separate terminals:

```bash
set -a
source "$HOME/.local/share/trading-max/secrets/trading_max.env"  # Linux
set +a
npm run dev:api
PORTFOLIO_BACKEND_URL=http://127.0.0.1:8421 npm run dev
```

For a local three-process run with the production boundary enabled:

```bash
deploy/local/start.sh
```

It initializes a missing state root, builds a missing web bundle, starts API,
worker, and web on loopback, and keeps logs outside the checkout. It does not
rerun setup when the bootstrap file already exists. Stop it with `Ctrl-C`.

On macOS the state file is under
`~/Library/Application Support/Trading Max/secrets/trading_max.env`. On
Windows, use the equivalent `%APPDATA%\Trading Max\secrets\trading_max.env`
location and set the same variables in the terminal that starts the API.

Open `http://127.0.0.1:3413`, go to **Settings**, and configure Trading 212 and
the optional LLM provider there. The browser never receives stored secrets.
They are written only to the OS credential manager:

- macOS Keychain;
- Windows Credential Manager;
- Linux Secret Service/keyring backend.

If the OS credential manager is unavailable, Settings shows an explicit error;
Trading Max never falls back to a plaintext secret file.

`trading-max setup` is idempotent: it preserves existing bootstrap values,
including the installation-specific credential namespace, and fills only
missing defaults. Use `trading-max doctor` for repeat diagnostics.

## Diagnostics

```bash
uv run --package trading-max-backend trading-max doctor
uv run --package trading-max-backend trading-max doctor --check-updates
```

The diagnostic command opens SQLite read-only and checks the state root,
bootstrap permissions and identity, latest packaged schema migration,
canonical public source remote, current revision, and worktree state. The
optional update check compares that revision with protected public `main`
without fetching, pulling, or modifying the checkout. It never prints remote
credentials, stored credentials, request headers, account data, or bootstrap
values.

## Production workstation process model

The supported production shape uses three separate processes: API, worker, and
Next.js web. `TRADING_MAX_ENV=production` rejects embedded workers and rejects
relative or checkout-local state roots. A platform supervisor (launchd on
macOS, systemd on Linux, or the Windows service manager) should own process
restart and load the same external bootstrap file. Do not bind either API or
web to `0.0.0.0` unless a future authenticated remote-access mode is enabled.

macOS users can register the current checkout as per-user launchd services with
`deploy/local/install-macos-service.py`. `deploy/local/start.sh` remains the
portable interactive foreground launcher. Linux systemd and Windows Service
installers are not shipped.
