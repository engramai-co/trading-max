# Desktop runtime preview

Status: internal packaging experiment; no public release or production migration.
Base product: 1.8.0. Target: Apple Silicon macOS.

## Purpose and scope

Prove that the existing Next.js/BFF and Python API can run inside an installable
Mac application without requiring the user to install Node, Python, Git or uv.
The approved onboarding prototype precedes this experiment. Real local account
enrollment and background collection remain later stages. A follow-up supports
explicitly connecting this App to an already configured HTTPS service.

## Approach and alternatives

Start with Tauri 2 and macOS WKWebView. Bundle the supported Node 22 runtime,
Next.js standalone output, a relocatable Python 3.12 runtime and locked runtime
dependencies. A packaged supervisor starts the real API and web server, reports
readiness and stops only its own children. If WebView compatibility or process
packaging cannot satisfy the existing application, evaluate Electron before any
BFF rewrite. Static export is not a viable replacement for the existing BFF.

## Isolation, privacy and compatibility

Use a separate application identifier and marked external preview data directory.
Local demo seeds only generated synthetic contract fixtures, using neither local
production state nor the ordinary Keychain namespace. Demo provider connections
and refresh mutations are disabled. Both demo listeners bind to loopback.
Remote pages receive no native process, filesystem or credential permissions.
The existing browser installation, storage contracts and Mac mini remain intact.
No data migration is performed; deleting the test app leaves preview data intact.

## Existing-server connection follow-up

The owner approved using the existing Tailscale Mac mini service and replacing
the local preview App with a client capable of connecting to it. A native
Settings window (`Cmd-,`) stores a non-secret connection profile locally. Remote
mode renders the existing web/BFF origin and starts no local server or collector.
The alternative of a local frontend calling the remote Python API would require
another authentication and API-version boundary; it is deferred. The existing
HTTPS website preserves server/frontend compatibility and the token boundary.

Local controls require the bundled origin and a known window label. Remote
pages remain outside the native capability boundary. A single driver owns local
demo process transitions; generation checks discard stale connection attempts.
TLS verification is mandatory, HTTP redirects are not followed by probes, and
connection diagnostics never include broker data or credentials. Test connection
does not save preferences or modify the server. Disconnecting and exiting only
affect this client. No public access, server migration, hidden background agent,
offline synchronization or cloud collector is introduced.

Accept against URL validation, wrong-service detection, TLS/transport failures,
bounded responses, late-result cancellation, native settings availability,
remembered launch, remote/demo switching, owned-process cleanup and unchanged
server collection. Keep the prior installed App for rollback. This remains an
internal desktop build on the 1.8.0 product base, not a new public release.

## Verification and release gate

Check installation paths containing spaces, cold/repeat startup, single instance,
close/reopen, occupied ports, child failure, retry and owned-child cleanup. Inspect
home, holdings, analytics, research and settings in WKWebView. Record full app/DMG
size, preview state, startup timings and process memory, including the runtimes.
A developer workstation test is not a substitute for a clean-machine test.
Developer ID signing, notarization and update signing are separate distribution
gates; an ad-hoc internal app is not a public release.

## Workspace entry integration — 2026-09-22

The approved first increment rebases the desktop sources onto the current
application mainline and gives first launch and native Settings one shared
workspace entry. Saved service profiles retain their schema, URL and auto-open
preference. Quick demo opens are transient and must not replace that profile.

Create/open-local-workspace destinations are visible with explicit preview
status. They neither claim successful enrollment nor access existing directories.
Real local directory validation, credential enrollment, first refresh and
readiness acceptance remain the next increment. No filesystem picker or new
remote-page native capability is added here.

The prior source/agent documentation and auto-discovered skill move to the
[onboarding archive](../archive/onboarding/README.md). Existing CLI behavior,
source deployments, backup and recovery support remain intact. Current entry
points describe the desktop preview's actual capabilities and link existing
source users to the retained references.
