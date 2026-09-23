# Trading Max agent instructions

## Onboarding and desktop work

The current onboarding direction is the native desktop entry described in
[desktop onboarding](docs/installation/desktop-onboarding.md). The former
source/agent workflow is [archived](docs/archive/onboarding/README.md); do not
activate its skill or treat it as the default onboarding experience.

The internal desktop preview supports existing HTTPS services, explicitly selected
local workspaces, and an isolated synthetic demo. New workspaces start empty;
first-sync acceptance remains incomplete until the user checks real broker totals. Do not describe the preview as a signed public installer or silently
substitute demo data when a real connection fails.

For an explicit request to maintain an existing source installation, use the
archived runbook as a compatibility reference. The CLI and `deploy/local`
scripts remain supported. Inspect checkout revision, process ownership, ports
and the selected external state root before making changes. Preserve existing
state and credentials, reuse an already queued first refresh, and distinguish
`doctor` configuration checks from actual runtime readiness.

Keep account credentials in the operating-system credential manager and have
users enter them in Settings. Never request secrets in chat, files, command
flags, screenshots or logs. Local services stay on loopback. Background/login
services and new network exposure need explicit task authorization. Existing
session authorization carries forward.

Preserve Trading 212 ingestion and Yahoo-compatible research. Alpaca and model
connections are optional. Accept real local enrollment only after a successful
refresh, JSON readiness reports `ready`, the worker is healthy and the user
confirms broker totals. Existing-server clients must not reconfigure the server.

## Development changes

- Keep runtime state, credentials, logs, broker exports, snapshots, generated
  research, and cached logos outside Git.
- Use synthetic fixtures in tests.
- Preserve the typed snapshot boundary and the independent research-lens API.
- Remote WebView pages receive no native commands, filesystem or credential access.
- Run the checks documented in `CONTRIBUTING.md` before publishing changes.
