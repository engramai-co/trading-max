# Advanced macOS service deployment

> **Not the first-run installer.** This profile is for an operator-managed,
> unattended macOS host. New users and coding agents should use
> `uv run --package trading-max-backend trading-max onboard` and `deploy/local` instead.

Trading Max runs as four user LaunchAgents:

- `com.engram.trading-max-api` on `127.0.0.1:8421`
- `com.engram.trading-max-web` on `127.0.0.1:3413`
- `com.engram.trading-max-worker` for durable refresh jobs
- `com.engram.trading-max-backup` for the 04:30 state backup

The web process talks to the API server-side. If an operator adds a private
reverse proxy, it must expose only the web process so API credentials never
reach the browser.

The only supported automation boundary is:

```bash
deploy/macos/deploy.sh <40-character-main-commit-sha>
```

The target must already be reachable from the freshly fetched `origin/main`.
Builds require Node.js 22. Set `TRADING_MAX_NODE_BINARY` to an existing Node 22
executable when the host default differs. The deployer retains that executable
inside the candidate release and uses it for both the build and web service;
it does not replace the host's global Node installation. Rollback restores the
previous release's runtime choice along with its service definitions.

Branch names, pull-request refs, and unrelated commits fail before the running
release is changed. Override `TRADING_MAX_SERVICE_ROOT`,
`TRADING_MAX_APP_ROOT`, or `TRADING_MAX_STATE_ROOT` only when the host was
provisioned with matching paths.

The API is the control plane: it writes refresh requests to `trading_max.db` and
returns immediately. The worker LaunchAgent claims jobs with a lease, executes
typed application stages, publishes the immutable snapshot, and can be
restarted without losing the queue.

The environment file belongs at:

```text
~/Library/Application Support/Trading Max/secrets/trading_max.env
```

The host configurator enables the lightweight alert monitor by default:
held positions refresh every 300 seconds and the remaining watchlist every
900 seconds. Override `TRADING_MAX_ALERT_HELD_INTERVAL_SECONDS` or
`TRADING_MAX_ALERT_WATCHLIST_INTERVAL_SECONDS` in the environment file when a
different cadence is needed.

It also enables broker-value intraday anchors around the clock, seven days a
week in Europe/London. One idempotent slot runs every 600 seconds and retains 210 days
in `account/nav/intraday_anchors.json`. This path only reads live account
values; it does not request Trading 212 history exports or run research/LLM
stages. Unified history supports cash-flow-aware money P&L when reconciled
evidence covers the interval; it does not certify intraday TWR. Older hosts may explicitly retain 40 or 120 days: raise retention to 210 days
to cover the full six-month view. Existing explicit settings survive upgrades.
A subsequent accounts refresh reconstructs the additional period where historical
prices are available; daily-only history stays daily and broker gaps stay gaps. See
[valuation history](../../docs/architecture/unified-nav-history.md). Disable collection with
`TRADING_MAX_INTRADAY_ENABLED=false`.

It must be mode `0600`. Snapshots, artifacts, the SQLite queue, and broker raw
state live below the configured state root; logs live in
`~/Library/Logs/Trading Max`.

`configure-host.py` creates this file with a stable internal API token and the
production paths. Deployment uses `--preserve-credentials`: it normalizes
bootstrap paths without opening the Keychain or migrating credentials. Credential
migration remains an explicit operator action from an unlocked login session.

LLM analysis initially runs with `TRADING_MAX_LLM_PROVIDER=fake`, so the complete
nightly/on-demand pipeline can be smoke-tested before any external credential
exists. Provider secrets are configured from the Settings page or the host
configurator and stored in the operating-system credential store; they must
never be committed or exposed to browser JavaScript.

OpenCode Go and DeepSeek use the same secret boundary. Select
`TRADING_MAX_LLM_PROVIDER=opencode` or `deepseek` only for bootstrap/migration;
the durable route policy in Settings controls the actual workload route. The
browser-facing API and stored analysis schema remain unchanged.

In production, DeepSeek and Trading 212 secrets live in the login Keychain
under the neutral service `com.engram.trading-max.credentials`; the environment
file contains only non-secret bootstrap configuration. Configure the provider
and store the key with:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" |
  .venv/bin/python deploy/macos/configure-host.py \
    --llm-provider deepseek \
    --llm-model deepseek-v4-flash \
    --deepseek-api-key-stdin
```

For OpenCode Go, use the provider-specific migration flag:

```bash
printf '%s\n' "$OPENCODE_API_KEY" |
  .venv/bin/python deploy/macos/configure-host.py \
    --llm-provider opencode \
    --llm-model deepseek-v4-flash \
    --opencode-api-key-stdin
```


Historical CFD records are imported once into the external state root by the
approved migration procedure. They remain a clearly labelled realized-cash
proxy for household net-worth history and never enter Invest/ISA portfolio or
strategy risk metrics.

## Isolated upgrades and recovery

The deploy script validates an exact protected-main commit, then builds Python
and the web app in a new `releases/<sha>-<unique-id>` directory. The active
`app` directory is untouched during dependency installation and compilation.
A host lock rejects concurrent deployments. After a successful build:

1. Create and verify an independent, deduplicated recovery snapshot while the
   current application stays available. Capture the existing service definitions
   and bootstrap env in `state/secrets/deployment-backups`.
2. Stop the existing services, including scheduled backup, and wait for their
   processes to exit. Backup compression no longer extends this downtime.
3. Retain the complete previous release and atomically point `app` at the new
   directory. The first upgrade converts the original directory to this layout.
4. Normalize bootstrap configuration, apply additive migrations, start the
   existing services, and check readiness, worker and dynamic web routes.

A failure after cutover starts restores the retained application, its installed
Python dependencies, web build, env and service definitions. Rollback never
requires a package download or rebuild. It does not restore the database:
legitimate writes and compatible migrations must remain intact. Release
acceptance must verify backward compatibility before upgrading. General state
restore is a separate operation; see [backup/restore](../../docs/installation/local-installation.md#backup-and-recovery).

Deployment records are mode `0600` in `service-root/deployments`. After an
uncatchable interruption, recover with the retained controller and the exact
record path (stop other deployment attempts first):

```bash
releases/<candidate>/.venv/bin/python releases/<candidate>/deploy/macos/release-manager.py \
  --recover deployments/<transaction>.json
```

Use the configured `TRADING_MAX_SERVICE_ROOT` and `TRADING_MAX_STATE_ROOT` when
the host uses non-default locations. Recovery restores existing services;
it never configures network exposure. Keep retained runtimes and private
configuration backups until acceptance and the rollback retention period end.
No release-directory deletion runs during deployment. See
[storage maintenance](../../docs/operations/storage-maintenance.md) for the
separate, bounded cleanup procedure and recovery-copy retention policy.
