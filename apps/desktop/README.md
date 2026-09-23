# Trading Max desktop preview

An internal Apple Silicon macOS packaging experiment for product **1.9.3**.
It can connect to an existing Trading Max HTTPS service in a Tauri 2 / WKWebView
window, or run the bundled web app and typed API with an explicitly selected
local workspace. A separate synthetic demo remains available. Connecting to
the owner's existing service does not migrate or reconfigure that service.

## Workspace entry

The bundled entry follows the accepted onboarding direction: create a local
workspace, open an existing workspace, or connect to an existing HTTPS service.
Create chooses a parent folder and creates a private named workspace; Open
inspects an existing desktop workspace. The App starts an empty workspace into
Settings, where the existing test-before-save account UI leads to first-sync
progress and an explicit balance check. Read the [current onboarding guide](../../docs/installation/desktop-onboarding.md).

A saved HTTPS service and up to eight local workspaces appear as recent entries. Settings and the first-run
screen share the same entry and connection form. The separate local demo is a
temporary action: opening it does not overwrite the persisted server profile or
its auto-connect preference. Quit/reopen restores the saved service choice.

The native shell and packaged web/API use the 1.9.3 application base. Remote mode
still renders the selected service's own web release. Both modes retain their
existing permission and process boundaries.

## Connect to an existing service

Open **Trading Max → Workspace and connections…** (`Cmd-,`) and choose **Connect to existing
service**. Enter a display name and an HTTPS root URL, test the connection, then
save and open it. A Tailscale hostname works when this Mac is already connected
to the appropriate tailnet. No broker key or internal API token is needed on
the client. The web service retains its existing permissions.

Settings are a bundled local window, available even when the server is offline.
Remote mode does not start bundled Node, Python or collection processes.
Closing this App does not stop or change the remote server. Local demo remains
an explicit choice; failed remote connections never fall back to mock balances.

The native client verifies normal system TLS trust and identifies the backend
through the existing read-only `/api/backend/health` route. Redirects, credential
URLs, non-HTTPS endpoints and oversized responses are rejected. Availability is
checked every 45 seconds while connected. One failed check keeps the page available;
persistent failure shows recovery, with retries after 15, 30 and 60 seconds before
manual retry is required. Initial connection gets two retries after 5 and 15
seconds. Cancelling invalidates pending attempts; a recovered service opens again. Degraded worker state is visible
in App Settings without hiding readable data. Initial connection and page-load
failures offer retry, settings and browser actions. There is no offline portfolio
copy in this iteration.

The selected profile is stored as mode-0600 `connection.json` in the App data
directory. It contains mode, name, URL and auto-connect preference. A separate
mode-0600 `connection-status.json` contains bounded connection diagnostics,
never account payloads or credentials. Personal hostnames are not embedded in
source or the distributable. Remote pages receive no native commands or
capabilities; only the exact selected origin is displayed in the workspace.
External links open in the system browser. Preferences and the connection menu
remain available independently of the remote webpage.

## What is included

- Node 22, the Next.js standalone server, standalone Python 3.12, locked Python
  dependencies, SQL migrations, and the existing API/application code.
- In local demo mode, synthetic account, history and research fixtures. They are **not real
  broker balances or market prices**. Search and price-chart adapters are local
  synthetic implementations for the preview's BE instrument.
- A native startup screen, retry after a service failure, single instance behavior
  and an owned-process supervisor. Closing the window or pressing Cmd-Q quits this
  preview and its services. Keeping a hidden collector running is a later step.

No developer tools are needed on the destination Mac. Both services bind only to
`127.0.0.1` on available ports; normal browser/production ports are not taken over.
The browser app receives no native filesystem, shell or credential capabilities.

## Data and ownership

App preferences and demo state use
`~/Library/Application Support/com.engram.trading-max.desktop-preview`.
Real account state lives exclusively in the user-selected workspace folder. Its
`trading-max-workspace.json` stores a UUID, name, format and application version;
Keychain uses `com.engram.trading-max.workspace.<uuid>`. A separate confirmation
receipt records the checked snapshot and connection revisions, not secrets.
The App does not import or modify an existing source-deployment root.
The directory must have the preview's identity marker; an unknown existing
directory is rejected. Synthetic state is seeded once and survives reopening.
Deleting the app leaves this independent preview data in place.

In local demo mode, the supervisor clears inherited configuration and secrets, uses a separate
credential namespace, supplies an empty credential store, disables schedules and
rejects API mutations. It never opens the ordinary Trading Max state directory.
Bundled stock prices and search use synthetic adapters. Python socket connections
to external hosts are rejected as an additional guard, not as an OS-level network
sandbox (native libraries and the webview are separate network clients).

`logs/launcher.log`, `logs/api-process.log` and `logs/web-process.log` in the preview
directory contain startup diagnostics. Process logs are replaced on each launch.
`runtime-status.json` records readiness and owned process IDs; it contains no API
token. Next's generated standalone entry uses its bounded in-memory cache and
disables fetch/image disk caches so navigation cannot invalidate the signed app.
The packaging step checks the generated entry contract and fails on an unknown
format. Persistent application state stays outside the bundle.
The native shell creates a dedicated process group, and every subprocess
watches its parent. Process cleanup never searches by executable name or port.

## Build on an Apple Silicon Mac

Use the repository's supported Node 22 and uv toolchain plus Rust 1.85+ and Xcode.
From the checkout root:

```sh
uv sync --all-packages --group dev --frozen
npm ci --prefix apps/web
npm run build --prefix apps/web
npm ci --prefix apps/desktop
uv run --frozen python apps/desktop/scripts/prepare_payload.py \
  --python-home /absolute/path/to/standalone/cpython-3.12-macos-aarch64 \
  --node /absolute/path/to/node-22/bin/node
npm run build --prefix apps/desktop
```

`--python-home` must be a **relocatable standalone CPython distribution**, not a
venv or a Homebrew interpreter linked against libraries on the build machine.
Payloads and build output are ignored by Git. The bundle is written to
`src-tauri/target/release/bundle/macos/Trading Max Preview.app` under this directory.
Record the runtime provenance and hashes with the final artifact; the package's
`runtime/build-info.json` records the base application revision and Node checksum.

## Verification

```sh
uv run --frozen ruff check apps/desktop/scripts apps/desktop/tests
uv run --frozen ruff format --check apps/desktop/scripts apps/desktop/tests
python3 -m unittest discover -s apps/desktop/tests -v
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
node --check apps/desktop/splash/app.js
python3 apps/desktop/scripts/validate_runtime.py \
  apps/desktop/payload /absolute/path/outside/checkout/runtime-checks.json
```

The harness also suspends each owned API/web process to test sustained liveness
failures and cleanup, then creates a real-mode empty workspace with no credentials, verifies
Settings remains accessible while data readiness is false, rejects premature
refresh/confirmation, tests ownership and reopening, and checks no demo data was
seeded.

The integration harness launches the real packaged runtimes with a fresh HOME,
system-only PATH, synthetic state and paths containing spaces. It probes page
responses, history data, occupied ports, duplicate ownership, rejected mutations,
normal shutdown, killed children and a killed supervisor. HTTP response timing is
not a measurement of a rendered WebView screen. The harness also checks every
runtime file before and after use, including a company-logo request that exercises
Next's fetch cache. Inspect the actual .app separately. The current acceptance is
on the owner's Mac; clean-machine installation remains a public-release gate.

The original existing-server follow-up was accepted on the owner's Mac on 2026-09-21:
eight native unit tests and five supervisor tests passed, as did Clippy and the
release bundle signature check. The installed App remembered the HTTPS service
on reopening; native Settings, the read-only connection test, invalid-address
feedback, network-failure retry and explicit demo/remote switching were exercised.
Switching back to remote stopped all three owned demo processes. With the client
quit, the unchanged remote worker completed its next scheduled 600-second live
collection. Evidence and real-account screenshots are kept outside the repository.
This verifies the desktop connection path, not public distribution or every
production page.

For a local investigation of a WebView rendering problem, build with
`npm run build --prefix apps/desktop -- --features diagnostics`. This opt-in build
opens Web Inspector. Rebuild without the flag for the distributable. The main
window is created visible, centered, and explicitly focused. Creating
it hidden and immediately showing it can leave the replacement WKWebView page
marked as hidden on macOS, postponing rendering and chart initialization.
Startup must render without requiring a manual window resize. Opening a
temporary demo reveals the workspace just as a saved connection does, without
persisting the temporary selection.

## Recovery and version checks

Local runtime liveness checks run every 15 seconds with a two-second timeout.
The bundled entry and portfolio use separate WebViews. The entry never navigates
to HTTP; failures reveal its existing local controls, even when the portfolio
WebView cannot load. Only bundled entry/settings surfaces accept native commands.
Four consecutive misses for either service stop the owned pair and return to the
native recovery screen. A healthy HTTP API with no first snapshot is responsive,
not a process failure. Local recovery preserves the folder and credentials, and
browser actions target only the active workspace/service rather than a saved
but inactive server profile. Technical startup details are collapsed by default.

Native Settings explains local versus remote collection and can reveal the
selected local folder. **Version & updates** checks the canonical GitHub stable
release only when clicked. The request has TLS verification, no redirects,
bounded time/body, strict version parsing and a fixed release-notes origin. No
account, workspace or remote-service address is sent. It reports the repository
release separately from this internal App, and has no download/install action.
The check cannot update Mac mini or migrate local data. There is no automatic
updater or new native permission for web pages.

## Distribution gate

The current configuration uses ad-hoc signing for an internal local experiment.
Do not describe it as a public installer. Developer ID signing, notarization,
update signing, clean-machine verification and real-account acceptance must be
accepted before a public desktop release. No production deployment or data
migration is part of this experiment. The former source/agent onboarding
documentation is [archived](../../docs/archive/onboarding/README.md); the current
entry and capability status are in [desktop onboarding](../../docs/installation/desktop-onboarding.md).

Architecture and acceptance scope: [desktop preview RFC](../../docs/architecture/desktop-preview-rfc.md).
