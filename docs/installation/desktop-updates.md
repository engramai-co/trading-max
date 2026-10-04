# Desktop installation, updates and recovery

The desktop remains an internal Apple Silicon preview until the signed package
and final clean-Mac acceptance gates pass. A GitHub source release alone is not a
desktop installer. The App's **Settings → About & updates** distinguishes the two.

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
3. Download in the browser, quit Trading Max with **Cmd-Q**, and open the DMG.
   Drag the application to its existing installation location and choose Replace.
   Usually this is `/Applications`; preserve a custom location if used. Eject
   the DMG, then open the installed application rather than running from the image.
4. Open the same workspace or saved HTTPS service. The bundle identifier stays
   unchanged, so App preferences and recent workspaces remain available. Local
   data and Keychain credentials live outside the application bundle.

This is an explicit **manual signed-package update**, not an automatic updater.
The App validates official release metadata, not the browser's downloaded bytes.
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

- **Before replacing the App:** an interrupted browser download has not changed
  the installed application or its data. Retry the download.
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
4. Finish the final clean-Mac install/onboarding and upgrade/window-lifecycle
   acceptance. **This remains the last gate; generating a manifest is not acceptance.**
5. Attach the verified DMG and JSON to the same stable `vX.Y.Z` GitHub release;
   publish the DMG first and the manifest last. Do not overwrite published assets.
   A partially published pair is not offered as an update. Check both GitHub asset
   digests and exercise the App's download action against the published release.

The JSON is release evidence authenticated by the canonical GitHub HTTPS origin;
it is not a detached cryptographic updater signature. A future automatic binary
updater must add its own signed-artifact verification and replacement/recovery
acceptance. The manual signed-package path does not imply that work is complete.

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
  --keychain-profile TradingMax --no-wait --output-format json
xcrun notarytool info APP_SUBMISSION_UUID --keychain-profile TradingMax --output-format json
```

Save the submission UUID with the private release evidence. Check an existing
submission until its status is `Accepted`; a timeout or `In Progress` is not a
rejection and must not trigger duplicate uploads. If a submission command ends
without a usable UUID, inspect `notarytool history` before submitting again.
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
  --keychain-profile TradingMax --no-wait --output-format json
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
