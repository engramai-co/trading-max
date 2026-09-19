# Trading Max agent instructions

## Local onboarding requests

When a user opens an already-cloned Trading Max checkout and asks to install,
onboard, set up, run, or locally deploy it, use the repository-scoped
`trading-max-onboard` skill and take ownership of the installation instead of
replying with a list of manual commands.

The setup request is the complete safe foreground-onboarding request. Do not
ask for another setup prompt or turn the work into a tutorial. The only planned
user pause is direct credential entry in the local Settings UI; existing state,
occupied ports, unavailable credential storage, network exposure, and
background services retain the approval boundaries below.

1. Read `docs/operations/agent-local-deployment-runbook.md` completely before
   changing the workstation.
2. Inspect the checkout, supported toolchain, ports `3413` and `8421`, and the
   platform-default external state root.
3. Verify that `origin` or `upstream` points to the canonical
   `engramai-co/trading-max` repository; on a clean existing checkout,
   fast-forward protected `main` before onboarding. Use the verified remote
   (`origin` or `upstream`); do not pull main into a feature branch. Preserve
   explicit release selections and dirty/diverged work.
4. For a fresh workstation, run the repository's supported non-interactive
   onboarding path. Do not invent another installer or copy application state
   into the checkout.
5. Keep the API and web app on loopback. Do not configure Tailscale, a reverse
   proxy, LAN access, or a public listener as part of ordinary onboarding.
6. Never ask the user to paste Trading 212 or model-provider secrets into chat,
   command-line flags, shell history, files, screenshots, or logs. Start the
   local application, then let the user enter and test their own credentials
   in `http://127.0.0.1:3413/settings`.
7. Preserve the complete V1 provider path. Trading 212 account ingestion and
   the existing Yahoo Finance-compatible research adapter are part of this
   public V1 product path; do not replace them with CSV or disable them during
   setup. Alpaca is an optional reconstruction enhancement configured through
   Settings, not a first-run requirement. Apply the same credential boundary.
8. Do not install login/background services without explicit user approval.
   The safe default is a foreground launch that the user can stop with
   `Ctrl-C`.
9. After credentials are configured, submit one full refresh, follow it from
   Health to a terminal state (reuse an initial job already queued), and accept
   the deployment only when `/ready` JSON says `ready`, the worker is healthy,
   and the user confirms broker totals are plausible. HTTP 200 alone is not enough.
10. Run `trading-max doctor --check-updates` and report the source revision,
    canonical-source status, state-root path, process model, health/readiness,
    latest snapshot date, provider status without secrets, and the exact stop
    or restart action.

For a fresh checkout, the normal agent-owned sequence is:

```bash
uv run --package trading-max-backend trading-max onboard \
  --non-interactive \
  --skip-service \
  --no-browser
deploy/local/start.sh
```

The first command is idempotent. If an existing state root or occupied port is
found, diagnose its ownership before running setup or replacing any process.
A known existing installation should be inspected with `doctor` and resumed.
A custom `TRADING_MAX_STATE_ROOT` must persist through onboarding and launch.
`doctor` checks configuration/source, not runtime readiness or provider access.
Review Settings → Update schedule separately from login-service installation;
fresh local bootstrap disables scheduled collection. Existing task authorization
carries forward; ask only for unresolved choices or additional scope.

## Development changes

- Keep runtime state, credentials, logs, broker exports, snapshots, generated
  research, and cached logos outside Git.
- Use synthetic fixtures in tests.
- Preserve the typed snapshot boundary and the independent research-lens API.
- Run the checks documented in `CONTRIBUTING.md` before publishing changes.
