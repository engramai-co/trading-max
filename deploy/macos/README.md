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
week in Europe/London. One idempotent slot runs every 600 seconds and retains 40 days
in `account/nav/intraday_anchors.json`. This path only reads live account
values; it does not request Trading 212 history exports or run research/LLM
stages. Because the live snapshot has no verified cash-flow stream, short-range
charts label the result as value change rather than TWR. Disable it safely with
`TRADING_MAX_INTRADAY_ENABLED=false`.

It must be mode `0600`. Snapshots, artifacts, the SQLite queue, and broker raw
state live below the configured state root; logs live in
`~/Library/Logs/Trading Max`.

`configure-host.py` creates this file with a stable internal API token and the
production paths. Every deployment also runs it after the build gate, so a
legacy bootstrap env is normalized and any broker/LLM secrets still present in
that file are moved into the login Keychain without logging secret values. It
can merge Invest/ISA credential JSON from standard input as well.

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

Automated deployment passes a headless-safe defer flag. If macOS returns
`errSecInteractionNotAllowed`, it keeps the existing credentials in the
mode-`0600` env file and logs a warning instead of dropping them or taking the
site down. Run the configurator again from an unlocked login session to finish
the Keychain migration.

Historical CFD records are imported once into the external state root by the
approved migration procedure. They remain a clearly labelled realized-cash
proxy for household net-worth history and never enter Invest/ISA portfolio or
strategy risk metrics.
