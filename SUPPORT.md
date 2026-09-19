# Support

Trading Max is maintained as a local-first open-source project. Community
support is best effort and does not provide investment, tax, legal, brokerage,
or uptime advice.

## Before opening an issue

1. Read the [installation guide](docs/installation/local-installation.md) and
   run `uv run --package trading-max-backend trading-max doctor --check-updates`
   with the installation's state root. This diagnoses configuration/source; it
   does not verify provider access or running services.
2. Check the Health page, `/health` and `/ready` JSON status, worker heartbeat
   and the relevant job's failed stage. HTTP 200 alone is not readiness. Preserve
   the last valid snapshot; do not reset state or repeatedly submit refreshes.
3. Search existing issues.
4. Reproduce on a supported platform and the latest supported release.
5. Remove credentials, portfolio values, account identifiers, private
   hostnames, and personal paths from logs and screenshots.

Include the product version, source commit, platform, foreground/service mode
and redacted diagnostic results. A dirty checkout or source-update warning is
distinct from a runtime/provider failure.

Use the bug issue form for reproducible defects and the feature form for
proposals. Maintainers triage new issues on a best-effort basis; response and
resolution times are not guaranteed.

Do not use public issues for vulnerabilities. Follow
[SECURITY.md](SECURITY.md) instead.

## Supported boundary

The first supported production boundary is one operating-system user on macOS,
with browser, web server, API, worker, state, and credential manager on the same
computer. Linux desktop support is conditional on a working Secret Service
keyring. Windows, headless Linux, public-internet hosting, multi-user auth, and
automated trade execution are outside that boundary unless a release says
otherwise.
