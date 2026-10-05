# Desktop in-app updates and resumable releases

Decision for 1.12.0; [tracking issue #110](https://github.com/engramai-co/trading-max/issues/110).
The browser product and remote services retain their existing behavior.

## User flow and ownership

App Settings checks official GitHub releases only when requested. A newer desktop
release needs a verified DMG/JSON pair and a signed XML appcast. **Update in App**
opens Sparkle's native download, consent, installation and restart interface.
Manual DMG download remains available. There is no background polling, silent
installation, automatic downgrade, login service or collection change.

1.11.0 predates the updater: install the first updater-enabled release once from
its official DMG. Subsequent releases can use the in-app path. Installing the
client does not update Mac mini or any selected HTTPS service.

Before relaunch, stop only the App-owned local process group. A private one-use
intent reopens the active source without changing the saved startup preference.
Only bundled App windows can request updates. Remote/local HTTP content receives
no native updater, filesystem, process or Keychain capability.

## Trust and failure boundaries

The Rust boundary rechecks the exact stable release, canonical repository, asset
names, size, architecture, manifest hash, publisher and bundle identity. It passes
only an internally constructed version-specific feed URL to Objective-C; the
renderer cannot supply a URL or installation path. The native delegate additionally
requires the feed item to match that version, DMG URL and length, with no delta or
information-only item.

Sparkle 2.10.0 verifies both the Ed25519-signed feed and archive before extraction.
Signed-feed expiry fallback is disabled. Developer ID, Hardened Runtime,
notarization and Gatekeeper remain separate checks. Signing private keys stay in
Keychain; only the public Ed25519 key is embedded in Info.plist. The build pins the
SDK archive hash/size and verifies its extracted inventory before reuse. The
framework and nested helpers are re-signed with the same Developer ID as the App.
Its upstream license ships inside the framework.

An interrupted download, cancelled update or failed signature check leaves the
installed application in place. Sparkle owns replacement and installation-error
recovery. This does not promise rollback after arbitrary later application faults.
Local database startup/migration failures use the independent
[workspace recovery transaction](desktop-upgrade-recovery.md); records committed
after a successful upgrade are never silently rewound.

## Maintainer release state

`apps/desktop/scripts/release_macos.py` runs on a signing Mac using existing
Developer ID and notarization Keychain profiles. It never exports credentials or
uploads account data. Private outputs must be outside Git.

The ordered stages are locked build, separate signed App, App notarization/staple,
signed DMG, DMG notarization/staple, actual-image verification, isolated runtime
acceptance, and signed appcast. Every command has retained stdout/stderr and a
durable state record. The candidate binds source tree, version and artifact hashes.
A process lock prevents overlapping jobs; an interrupted driver's current child
retains the lock until it exits. Bounded waits return with the current stage saved.

Resume queries the saved Apple UUID. A completed upload receipt can be recovered
after driver interruption. A partial or ambiguous upload stops for reconciliation
with Apple's history; it is never automatically duplicated. An Invalid response
saves the rejection log and stops. Fixes require a new candidate directory.
Existing output is retained, and a completed feed is adopted only after verifying
both signatures and its exact expected content.

Publication is a separate command after native acceptance. It requires the exact
DMG hash and evidence for installation, update success, interrupted download,
signature rejection, cancellation/failure, runtime shutdown and restored source
preferences. The normal main-branch workflow creates the source tag/release;
the driver verifies that tag's tree matches the accepted candidate. Assets are
uploaded DMG → JSON → XML. Matching existing assets are reused; conflicting names
are never overwritten. An incomplete pair cannot become a manual download, and
an incomplete triple cannot become an in-app update.

## Alternatives and verification

A custom downloader/installer would duplicate native replacement and recovery
logic. Sparkle supplies a maintained macOS implementation and native consent UI.
Tauri's updater was considered; an upstream macOS installation-failure report
made Sparkle the preferred implementation for this release. Existing manual DMG
installation remains the fallback and the bootstrap path.

Synthetic tests cover metadata, updater presentation, one-use restart intent,
modified SDK/artifacts, duplicate-upload prevention, resumable receipts and
publication gates. macOS CI compiles the native bridge. Actual signed-package
acceptance is required separately; tests alone do not mark a release accepted.
An isolated older test host can exercise Sparkle replacement without falsely
claiming that 1.11.0 already supports in-app updates. Record that distinction and
the test Mac's OS in the private release evidence.

References: [Sparkle setup](https://sparkle-project.org/documentation/),
[programmatic setup](https://sparkle-project.org/documentation/programmatic-setup/),
[customization](https://sparkle-project.org/documentation/customization/),
[installer implementation](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Autoupdate/SUPlainInstaller.m),
and [Tauri updater issue #3505](https://github.com/tauri-apps/plugins-workspace/issues/3505).
