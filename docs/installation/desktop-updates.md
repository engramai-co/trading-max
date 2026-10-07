# Desktop installation, updates and recovery

Trading Max 1.12.3 provides an Apple Silicon macOS preview as a Developer ID
signed and Apple-notarized DMG. Get the package and verification manifest from
the [official release](https://github.com/engramai-co/trading-max/releases/tag/v1.12.3).
A GitHub source archive alone is not a desktop installer. The App's
**Settings → About & updates** distinguishes the two.

## Verified scope for 1.12.3

The signed App and final DMG passed Apple notarization, stapling, signature and
Gatekeeper checks. All 19 packaged runtime checks passed, including process
cleanup, isolated empty/demo workspaces and failed-upgrade recovery.

Native acceptance on Apple Silicon macOS 26.5.2 used synthetic data and a private
older-version fixture with the released updater implementation. Invalid signed
feeds, modified archives, interrupted downloads and cancellation left the
installed application unchanged. The exact final DMG then installed and relaunched
as 1.12.3, reopened the active demo, stopped the previous runtime and preserved
saved connection preferences. Normal quit also stopped the new owned services.

After publication, anonymous downloads of the DMG, manifest and appcast matched
the accepted local bytes and both update signatures verified. An unmodified
installed 1.12.0 App discovered 1.12.3 through the public release, completed the
in-app update and reopened its saved HTTPS service with startup preferences
unchanged. The installed App again passed signature, staple and Gatekeeper checks.

This is not fresh-OS or macOS 13 native UI acceptance, nor a new real-broker
first-sync test. New accounts still need a successful refresh, healthy worker
and readiness status, and the owner's confirmation of broker totals.

## Verified scope for 1.11.0

The release owner selected acceptance on the existing Mac. The actual notarized
DMG was installed with isolated App preferences, a new empty workspace and a
workspace created by the previous 1.10.0 App. Native first launch, upgrading,
recovery-point access, auxiliary/main window closure, Cmd-Q, reopening and
restoration of the original connection preferences passed. The installed package
also passed all 19 runtime checks, including failed-upgrade rollback, using
bundled Python/Node and a system-only PATH.

Native acceptance ran on Apple Silicon macOS 26.5.2. The package declares macOS
13.0 and every native component's deployment target and library paths were
verified; this is not a claim of a native UI test on macOS 13 or a freshly
installed macOS system. This installation run did not repeat real-broker first
sync. Each newly connected account still requires a successful refresh, healthy
readiness/worker status and the owner's balance confirmation.

## Obtain and install an update

1. Click **Check version** in App Settings. The explicit request goes only to the
   canonical `engramai-co/trading-max` GitHub release endpoints, without account,
   workspace, credential or saved-server information. There is no background poll.
2. A desktop download appears only when an official stable release contains the
   Apple Silicon DMG and matching verified distribution manifest. The App checks
   the manifest's digest, version, architecture, bundle ID, publisher, minimum
   macOS and agreement with GitHub's DMG size/digest. It rechecks the exact release
   when Download is clicked. Source-only releases, incomplete uploads, mismatched
   metadata and older-than-installed packages do not offer a download.
3. On 1.12.0 or newer, **Update in App** appears when the newer release also has
   a signed appcast. Sparkle shows the available update, verifies the download and
   asks to install/restart. Keep the App open while downloading; cancelling or an
   interrupted download leaves the installed version available. There are no
   automatic checks or silent installations.
4. For 1.11.0, or when using the manual fallback, download in the browser, quit Trading Max with **Cmd-Q**, and open the DMG.
   Drag the application to its existing installation location and choose Replace.
   Usually this is `/Applications`; preserve a custom location if used. Eject
   the DMG, then open the installed application rather than running from the image.
5. Open the same workspace or saved HTTPS service. An in-app restart reopens
   the active source without changing your saved startup preference. The bundle identifier stays
   unchanged, so App preferences and recent workspaces remain available. Local
   data and Keychain credentials live outside the application bundle.

The first upgrade from 1.11.0 is an explicit **manual signed-package update**;
it installs the updater needed for subsequent releases. The browser fallback
validates release metadata but does not inspect the browser’s downloaded bytes.
The in-app path verifies both the signed feed and the downloaded archive before
extraction and installation.
macOS checks the downloaded application through Gatekeeper; do not bypass a
signature, damaged-app or unverified-developer warning. Re-download from the
official release and report the exact warning instead. Advanced users can compare
the displayed SHA-256 with the downloaded DMG using `shasum -a 256`.

The current query searches the newest 30 releases and reports that scope when no
desktop package is available. Repository and desktop versions can differ. A
same-version desktop package can be downloaded again; a newer local build is never
offered an older package. Failed checks do not disable portfolio use. The offline
**Help & recovery** page remains available from App Settings.

## If the upgraded application fails

- **Before replacing the App:** an interrupted download, cancelled update or
  signature failure leaves the installed application in place. Retry from App
  Settings or use the official DMG. Do not bypass verification warnings.
- **First local startup of a newer version:** the existing upgrade guard creates
  a verified recovery point before starting the services against an existing
  database. Startup/migration failure stops owned processes and restores the
  previous workspace generation. Failed-start files are retained separately.
- **Interrupted recovery:** reopening the same workspace resumes its recovery
  journal before compatibility inspection. Insufficient space, corrupt backup,
  changed workspace identity or a conflicting active process prevents destructive
  moves and produces an error. Preserve both the workspace and recovery directory.
- **After a successful upgrade:** later records are not automatically rewound.
  Do not use an older App on a newer workspace or manually replace its database.
  The workspace guard does not replace the application binary. Recovering a
  previously committed workspace is a separate, deliberate restore operation.
- **Remote mode:** upgrading the client never upgrades, migrates or restarts the
  remote service. Connectivity recovery and server recovery are separate operations.

For the selected local workspace, **Help & recovery → Show recovery files in Finder**
opens its existing recovery directory. It does not create, restore or delete data.
The directory is under the App's Application Support folder at
`workspace-recovery/<workspace UUID>`; `transaction.json` records the latest
upgrade state, `repository` holds recovery objects, and a failed attempt can leave
`<transaction UUID>/failed-start`. These are private financial records, not files
to upload to a public issue. The current recovery path requires the workspace and
recovery directory to be on the same filesystem volume.

## Uninstall and retain data

Quit the App and move its `.app` bundle to Trash. This stops only its owned local
services. It leaves the user-selected workspace, App preferences, recovery points
and Keychain credentials intact. A remote server continues independently.

Reinstalling the same application identity can reopen these workspaces. Complete
data erasure is separate from uninstall: after verifying a recoverable backup,
remove only the workspaces and recovery copies you intentionally no longer need.
Manage account credentials from the workspace's connection settings or Keychain
Access (`com.engram.trading-max.workspace.<UUID>`). Removing only the application
does not revoke broker API keys. Generic application cleaners can remove recovery
information, so they are not part of this update/uninstall procedure.

Local collection requires the App to be running on an awake, connected Mac.
Quitting, sleeping and shutting down pause it. A remote server owns its own
collection schedule. Neither the installation nor an update installs a hidden
login/background collector.

## Report a problem

Use the [project issue tracker](https://github.com/engramai-co/trading-max/issues)
for a non-sensitive report with the App version, macOS version, local/remote mode,
time and visible error. Redact personal hostnames and balances from screenshots.
Do not attach keys, broker exports, full workspaces or raw recovery/log directories.
For suspected security problems use [SECURITY.md](../../SECURITY.md).

## Maintainer distribution gate

An iOS/TestFlight signing setup confirms Developer Program access, but its cloud
signing certificate is not a local macOS Developer ID Application identity.
Use the existing organization to provision the appropriate identity. Signing keys
stay in Keychain or the release system's secret manager, never this repository.

1. Build the locked desktop payload and application as documented in the
   [desktop build guide](../../apps/desktop/README.md), then follow the signing
   commands below. The packager inventories every Mach-O file, including native
   Python/Node extensions, and signs them individually before sealing the App.
   It enables Hardened Runtime, gives only Node its JIT entitlement, and verifies
   the team, timestamp and entitlements after signing. It does not use `--deep`
   for signing or weaken library validation.
2. Notarize and staple the App, package it in a signed DMG, then notarize and staple
   that DMG. The package must retain the current bundle identity, contain only the
   intended Apple Silicon application, and match `VERSION` and its bundled runtime.
3. Run the verifier on the **actual DMG**, outside Git:

   ```sh
   uv run --frozen python apps/desktop/scripts/verify_distribution.py \
     /absolute/output/trading-max-vX.Y.Z-macos-arm64.dmg \
     --output /absolute/output/trading-max-vX.Y.Z-macos-arm64.json
   ```

   It verifies the DMG and mounted App signatures, expected Developer ID team,
   Hardened Runtime, stapled notarization, Gatekeeper assessment, architecture,
   identity and runtime version. It mounts read-only, detaches on failure and
   writes a manifest only after all checks pass. Existing output is not overwritten.
4. Finish installation/onboarding and upgrade/window-lifecycle acceptance on the
   actual package. Record the host, isolation, real-account checks and untested
   coverage. For 1.11.0 use the release owner's accepted same-Mac scope above;
   future untouched-host or minimum-OS tests must be recorded separately.
   **Generating a manifest alone is not installation acceptance.**
5. Attach the verified DMG, JSON and signed appcast to the same stable `vX.Y.Z`
   GitHub release; publish DMG first, JSON second, and XML last. Do not overwrite published assets.
   A partially published pair is not offered as an update. Check both GitHub asset
   digests and exercise the App's download action against the published release.

The JSON is release evidence authenticated by the canonical GitHub HTTPS origin.
The in-app path additionally requires the Ed25519-signed XML feed and archive.
See the [trust and recovery design](../architecture/desktop-in-app-updates.md).

### Reproducible signing and notarization

Use the certificate fingerprint from `security find-identity -v -p codesigning`.
It must be a **Developer ID Application** identity for the expected team; a
development or TestFlight certificate cannot replace it. The private key remains
in Keychain. Use a new output directory outside the checkout for each candidate;
the scripts refuse to replace an existing output or modify the input App.

```sh
uv run --frozen python apps/desktop/scripts/package_macos.py prepare \
  --app '/absolute/build/Trading Max Preview.app' \
  --output /absolute/output/release-candidate \
  --identity DEVELOPER_ID_CERTIFICATE_SHA1
```

This produces the signed App, a ZIP for Apple's notarization upload and a small
`signing-result.json`. It does not submit or publish anything. To test Hardened
Runtime locally using an existing **Apple Development** identity, add
`--internal-rehearsal`; that mode emits no upload ZIP and cannot produce a public
DMG or a verified release manifest. Test the copied runtime using the packaged
harness before moving to a real Developer ID candidate.

The payload builder selects hash-verified macOS 13-compatible Python wheels,
with source builds disabled. Signing and final DMG verification also inspect
every native component's arm64 deployment/load commands. A dependency requiring
newer macOS, or loading an absolute library outside Apple's system directories,
stops the release even when the outer App declares macOS 13. A successful launch
on a newer development Mac alone does not establish minimum-OS compatibility.

Create a named `notarytool` profile in Keychain using its secure interactive
prompt. The account holder enters the credential locally; do not put a password
in command arguments, shell history, source, screenshots or chat. If an appropriate
profile already exists, reuse it. For Apple ID authentication:

```sh
xcrun notarytool store-credentials TradingMax \
  --apple-id YOUR_APPLE_ACCOUNT_EMAIL --team-id H757XFW8A9
```

The prompt expects an Apple app-specific password. Store it in Keychain rather
than a release script. Submission commands use only the non-secret profile name:

```sh
xcrun notarytool submit /absolute/output/release-candidate/trading-max-vX.Y.Z-macos-arm64-app.zip \
  --keychain-profile TradingMax --no-s3-acceleration --no-wait --output-format json
xcrun notarytool info APP_SUBMISSION_UUID --keychain-profile TradingMax --output-format json
```

Save the submission UUID with the private release evidence. Check an existing
submission until its status is `Accepted`; a timeout or `In Progress` is not a
rejection and must not trigger duplicate uploads. If a submission command ends
without a usable UUID, inspect `notarytool history` before submitting again.
An explicit `abortedUpload` error is different: Apple can create a history entry
before the archive finishes uploading. An `In Progress` entry alone does not
prove that upload completed. Preserve the failure and use a bounded retry with
`--no-s3-acceleration` when the accelerated multipart transfer timed out. Track
the new successful upload receipt separately; do not wait indefinitely on the
incomplete upload's UUID or keep resubmitting a successfully uploaded archive.
An `Invalid` result stops the release; inspect Apple's log, fix the candidate and
start a fresh output directory. Do not bypass notarization or Gatekeeper.

After the App submission is accepted:

```sh
xcrun stapler staple '/absolute/output/release-candidate/Trading Max Preview.app'
uv run --frozen python apps/desktop/scripts/package_macos.py dmg \
  --app '/absolute/output/release-candidate/Trading Max Preview.app' \
  --output /absolute/output/release-candidate/trading-max-vX.Y.Z-macos-arm64.dmg \
  --identity DEVELOPER_ID_CERTIFICATE_SHA1
xcrun notarytool submit /absolute/output/release-candidate/trading-max-vX.Y.Z-macos-arm64.dmg \
  --keychain-profile TradingMax --no-s3-acceleration --no-wait --output-format json
xcrun notarytool info DMG_SUBMISSION_UUID --keychain-profile TradingMax --output-format json
```

The DMG stage checks the App's signature, staple and Gatekeeper assessment first.
Once the DMG submission is also accepted, staple the DMG and run
`verify_distribution.py` as shown above. Keep all outputs outside Git. Complete
the final installation acceptance before attaching the DMG/manifest pair to a
public release. The packager never installs, auto-publishes or changes a server.

References: [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
and [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Resumable release driver

Use the maintainer Mac’s existing Developer ID, notarization profile and Sparkle
Keychain identity. The SDK is pinned in `apps/desktop/sparkle.lock.json`; its
`generate_keys --account ACCOUNT -p` command prints only the public key. Preserve
the existing signing identity: do not regenerate it for each release or export
its private key to CI. No runner, background service or new network port is needed.

From a clean source commit after the contribution checks:

```sh
uv run --frozen python apps/desktop/scripts/release_macos.py prepare \
  --work-dir /absolute/private/release-candidate \
  --identity DEVELOPER_ID_CERTIFICATE_SHA1 --notary-profile TradingMax \
  --python-home /absolute/standalone/python --node /absolute/node-22/bin/node
uv run --frozen python apps/desktop/scripts/release_macos.py status \
  --work-dir /absolute/private/release-candidate
uv run --frozen python apps/desktop/scripts/release_macos.py resume \
  --work-dir /absolute/private/release-candidate
```

Pending notarization is a saved stage, not a failed build. Resume follows the
same UUID and never reuploads a confirmed submission. `--wait-seconds` optionally
waits for a bounded period; the default returns immediately when Apple is pending.
Ambiguous uploads retain their receipt and require reconciliation with Apple’s
history; Invalid submissions retain their rejection log. Start a new candidate
after changing source. Interrupted completed stages are retained and verified.

The final automatic stage produces a signed appcast and stops before publication.
Record native acceptance in a private JSON file containing `version`, the exact
DMG `sha256`, `host`, a path/description in `evidence`, and boolean `checks` for
`native_install`, `update_success`, `download_interrupt`, `signature_rejection`,
`install_cancel_or_failure`, `runtime_shutdown` and `relaunch_preferences`. These
are recorded test results, never assumed defaults. Preserve screenshots and
state/file comparisons, and distinguish a synthetic predecessor from a released
App. Do not mark an untested item true.

After the normal main workflow creates the matching source tag/release:

```sh
uv run --frozen python apps/desktop/scripts/release_macos.py publish \
  --work-dir /absolute/private/release-candidate \
  --acceptance /absolute/private/native-acceptance.json
```

Publication checks the source tag tree, all local hashes, signatures and exact-DMG
acceptance. It verifies GitHub’s asset digests after uploading. Rerunning reuses
matching assets and refuses conflicting names. Final public-download/native
checks remain separate from that API-level verification.
