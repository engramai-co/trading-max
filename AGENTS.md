# Trading Max agent instructions

## Onboarding and desktop work

The current onboarding direction is the native desktop entry described in
[desktop onboarding](docs/installation/desktop-onboarding.md). The former
source/agent workflow is [archived](docs/archive/onboarding/README.md); do not
activate its skill or treat it as the default onboarding experience.

The desktop preview supports existing HTTPS services, explicitly selected
local workspaces, and an isolated synthetic demo. New workspaces start empty;
first-sync acceptance remains incomplete until the user checks real broker totals.
Only verified Developer ID signed and notarized release assets qualify as public
installers; a source build alone does not. Never silently substitute demo data
when a real connection fails. See the distribution and acceptance scope in
[desktop updates](docs/installation/desktop-updates.md).

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

## Desktop release and native QA pitfalls

- Use the resumable release driver from a clean, matching source revision.
  Web deployment and a source release do not publish the desktop installer.
  Keep signing, notarization and native acceptance evidence outside Git; publish
  only the exact accepted DMG, manifest and signed appcast, in that order.
- After an interrupted notarization upload, inspect its saved receipt and Apple
  history before retrying. An `In Progress` history entry does not confirm upload
  completion. Preserve ambiguous attempts; a confirmed successful upload resumes
  with its existing submission ID. Never repeatedly submit an accepted artifact.
- Resolve the exact App path and process before launching native QA: release,
  build and fixture copies share a bundle identifier. A failed UI lookup may
  itself have launched the App; inspect processes before retrying it.
- If an App crashes or macOS shows **Reopen**, stop repeated launches and UI
  retries. Capture the first error, inspect the setup failure and repair its
  cause before one controlled retry. A restore prompt is not proof of a new
  crash; verify the process and crash timestamp. Do not automate a reopen loop.
- Initialize synthetic App data with the existing `runtime::prepare_root`
  contract **before** placing connection preferences or fixtures there. It
  rejects nonempty, unmarked directories. Never add its marker to an unknown
  user directory to bypass that protection.
- Native updater fixtures share the daily App's data and preferences namespace.
  Quit the App first, preserve the original state and verify the backup before
  switching to synthetic state. Record file hashes, modes and symlinks. Restore
  and compare the original state on success, failure or interruption; stop
  fixture-owned services and verify the fixture App process has exited before
  launching the daily App. A closed window or stopped services alone does not
  prove the App exited; duplicate bundle IDs can misroute UI/updater actions.
  Restore product preferences without replaying stale
  macOS crash/window-restoration state into a healthy launch.
- Exercise updater rejection, interrupted download, cancellation, installation,
  relaunch, preference retention and owned-process shutdown against the final
  signed DMG. Record observed results, distinguish private predecessor fixtures
  from released Apps, and verify the public update from an installed App.
- After publishing the desktop assets, update the README and download guides.
  Documentation and agent-instruction corrections alone keep the product version
  and do not require another application release or web deployment.

## Development changes

- Keep runtime state, credentials, logs, broker exports, snapshots, generated
  research, and cached logos outside Git.
- Use synthetic fixtures in tests.
- Preserve the typed snapshot boundary and the independent research-lens API.
- Remote WebView pages receive no native commands, filesystem or credential access.
- Run the checks documented in `CONTRIBUTING.md` before publishing changes.
