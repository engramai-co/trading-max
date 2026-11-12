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
- Before signing, confirm the login keychain is unlocked with a throwaway
  `codesign` probe; `errSecInternalComponent` means it is locked. A lock or
  reboot during signing is recoverable with `resume`: signing works on a copy
  and nothing reaches Apple until notarization starts.
- Bump versions only in our own package entries. Never replace the version
  string globally: a dependency can share it (`smallvec 1.16.1` broke a
  1.16.1 → 1.14.99 fixture build).
- After an interrupted notarization upload, inspect its saved receipt and Apple
  history before retrying. An `In Progress` history entry does not confirm upload
  completion. Preserve ambiguous attempts; a confirmed successful upload resumes
  with its existing submission ID. Never repeatedly submit an accepted artifact.
- Resolve the exact App path and process before launching native QA: release,
  build and fixture copies share a bundle identifier. A failed UI lookup may
  itself have launched the App; inspect processes before retrying it.
  After Cmd-Q, verify exit through process and runtime evidence first; a UI
  lookup can relaunch the target and invalidate shutdown or isolation checks.
  When UI lookups time out on a running App, activate that exact path with
  `open` (without `-n`) before retrying.
- The Mac may be in use during native QA. Record runtime status immediately
  after each relaunch. Explain an unexpected exit from logs (physical
  Multitouch events and `windowShouldClose` versus synthetic input) and record
  the observed sequence; never rewrite evidence to fit a script.
- If an App crashes or macOS shows **Reopen**, stop repeated launches and UI
  retries. Capture the first error, inspect the setup failure and repair its
  cause before one controlled retry. A restore prompt is not proof of a new
  crash; verify the process and crash timestamp. Do not automate a reopen loop.
- Initialize synthetic App data with the existing `runtime::prepare_root`
  contract **before** placing connection preferences or fixtures there. It
  rejects nonempty, unmarked directories. Never add its marker to an unknown
  user directory to bypass that protection.
- The desktop demo keeps its runtime under `demo/<App version>/` in the App
  data root. Read `runtime-status.json` and its logs there; the root holds only
  connection preferences and status, and an update starts a new demo root.
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
  Distinguish installation on normal quit followed by an explicit launch from
  the Install and Relaunch button path; passing one does not verify the other.
- After publishing the desktop assets, update the README and download guides.
  Documentation and agent-instruction corrections alone keep the product version
  and do not require another application release or web deployment.
- Remote connectivity, a loaded WebView and fresh account data are separate
  states. A failed health check must not close an already loaded workspace or
  its unsaved service forms; recovery must not navigate or steal focus. Retained
  pages must visibly disclose the interrupted connection, never imply live data.
  Keep automatic retries bounded per request and rate-capped; cancel/source
  changes must invalidate late results. Do not relax TLS or remote capabilities.

## Design principles

Aim for the finish of the Linear website or Apple Notes: a single clear purpose,
a simple architecture, restrained design and a refined implementation.

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
Remove slogan-style copy, helper text and secondary labels. If a screen needs
them to be understood, redesign the layout until the screen is self-evident.

Every design and technical decision must improve the user experience (UX), the
developer experience (DX) and the agent experience (AX) together, and must not
break any existing feature.

## Development changes

- Keep runtime state, credentials, logs, broker exports, snapshots, generated
  research, and cached logos outside Git.
- Use synthetic fixtures in tests. Keep synthetic credentials low-entropy
  (`synthetic-secret`): CI runs gitleaks over every commit in a pull request,
  and random-looking values such as `synthetic-secret-7f3a` fail it.
- Preserve the typed snapshot boundary and the independent research-lens API.
- Remote WebView pages receive no native commands, filesystem or credential access.
- After a deployment or a web-framework upgrade, load a data page in a real
  browser or request it with `Accept-Encoding: br, gzip`. Plain HTTP checks
  without that header can pass while browsers receive compressed bytes without
  `Content-Encoding` and show a data error.
- Run the checks documented in `CONTRIBUTING.md` before publishing changes.

## Trading 212 balances

- The account summary's `totalValue` leaves out uninvested pie cash
  (`cash.inPies`), which the summary still reports. Count pie cash only when
  the total includes it. Treat `reservedForOrders` as part of the total until
  real data shows otherwise.
- The Settings connection test reads a snapshot without the strict balance
  check, so it can pass while the first sync fails.
- Rebuilding daily values replays the retained broker rows. Keep that check's
  tolerance equal to the snapshot check's; a stricter replay turns a few pence
  of drift into a failure of every account update.
