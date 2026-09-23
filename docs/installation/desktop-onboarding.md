# Desktop onboarding

Status: **internal desktop preview** on the current **1.9.3** application base.
The entry flow is being integrated in small, independently accepted steps.
There is no signed public desktop installer yet.

Trading Max's desktop entry has three destinations:

| Destination | Current capability |
| --- | --- |
| Create a local workspace | Choose a folder and name, connect a read-only account, sync and check balances. |
| Open an existing workspace | Inspect a desktop workspace, check compatibility and open it. Older source-deployment roots are not adopted. |
| Connect to an existing service | Working HTTPS connection, remembered preferences and recovery. |

The separate **local demo** uses synthetic data. It must remain clearly labeled
and never substitute for an unavailable real account or service.

## Use an existing service

Open the App's **Settings** (`Cmd-,`) to select a workspace or connection. Choose
the existing-service entry, enter its HTTPS root URL, test, and save/open it.
Tailscale hostnames work when the Mac is already connected to that network.
The server continues to own account credentials and collection. Closing the
client does not stop that server.

The App preserves previously saved connection profiles and their auto-open
preference. Remote pages receive no native filesystem, process or credential
permissions. The local settings window is available even when the service is
unreachable.

## Create or open a local workspace

Choose **Create a local workspace**, give it a name and choose a parent folder.
The App creates a new private subfolder; it never overwrites an existing folder.
Choose **Open an existing workspace** to select a folder previously created by
the desktop App. Its identity, format, application/database compatibility and
process ownership are checked before startup. Future versions, demo state,
symlinked state and arbitrary source-deployment roots are rejected without migration.

Each workspace has a stable ID, independent data and its own OS credential
namespace. Recent workspaces are remembered separately from the existing HTTPS
service preference. A temporary local/demo session does not replace a saved
Mac mini connection or its auto-open preference. Moving a workspace to another
Mac preserves data, but credentials need to be connected again on that Mac.

An empty workspace opens **Settings → Accounts & data** with three steps:

1. Connect the Invest and/or ISA accounts you actually use. Enter read-only
   Trading 212 credentials directly into Settings, test, then save. Secrets are
   stored in Keychain, never the workspace folder.
2. Start the first full refresh. Progress follows the existing durable job queue;
   an active job is reused. A failure leaves settings and any previous successful
   snapshot intact, with a link to Data status and an explicit retry.
   Each refresh freezes the connected account selection: Invest-only and
   ISA-only workspaces are supported without creating a zero-valued substitute
   for an unconnected account.
3. Once a fresh account refresh succeeds and readiness/worker checks pass,
   compare the displayed GBP account values with Trading 212 and confirm them.
   A page load, old snapshot, skipped broker sync or research-only success does
   not complete onboarding. Changed account connections require a new check.

The App remains usable for Settings before it has a snapshot. Models and Alpaca
are optional; Yahoo-compatible market data remains the default. Automatic
recording can be enabled in Update schedule for the foreground App session.
Quitting the App stops its owned services; sleep pauses collection. No login
service is installed. The personal Mac mini collector is independent.

Implementation and synthetic tests are not a claim that a real account has been
accepted. Final real-account acceptance needs the owner's direct credentials,
a successful refresh, healthy worker and explicit balance confirmation.

## Recovery and version checks

The native entry remains available even when its selected service fails. A first
remote connection gets two automatic retries (after 5 and 15 seconds). An
established connection tolerates one failed check; persistent failures show a
recovery screen with bounded retries and an explicit cancel/retry action. It
never switches to demo data. Closing the client leaves a remote collector running.

Local workspaces check both process exit and HTTP responsiveness. Four consecutive
failed liveness checks, 15 seconds apart, stop only the owned runtime and offer
**Reopen workspace**. Retry uses the same folder; saved records and Keychain
connections are not reset. Account/data readiness is separate: an empty workspace
with a healthy worker shows **Ready for your first sync**, while failed jobs,
unhealthy workers and unexpected snapshot errors still need attention. An interrupted
refresh must be checked in Data status and retried; no missing record is fabricated.

Native Settings explains where collection runs and offers **Open data folder** for
the selected local workspace. **Version & updates** makes an explicit, read-only
request to the canonical repository's stable release endpoint, sending no account
or workspace details. A repository version is not a signed desktop update. This
preview neither downloads nor installs releases, changes the workspace, nor
updates an existing HTTPS service. Signed installation, migration/backup and
rollback acceptance remain part of the public distribution gate.

## Development and current source installations

See the [desktop build and test guide](../../apps/desktop/README.md) and the
[desktop architecture record](../architecture/desktop-preview-rfc.md).
The canonical repository is [engramai-co/trading-max](https://github.com/engramai-co/trading-max).

Existing source users can continue with the retained
[source-installation reference](../archive/onboarding/local-installation.md)
and its update, backup and recovery sections. `trading-max doctor --check-updates`
remains available for source/configuration diagnostics. The former agent skill
and runbook are [archived](../archive/onboarding/README.md) and no longer selected
automatically.

Before a public desktop release, complete real-account installation acceptance, Developer ID
signing/notarization, signed updates and installation acceptance on a Mac without
development tools. A virtual machine is not required for the current local
preview acceptance.

## First-sync recovery

A history window containing only cash movements may legitimately omit ticker,
quantity and price columns. The importer validates cash and securities reports
according to their content, preserves original amounts and currencies, and
rejects incomplete trade schemas or conflicting transaction IDs. Deterministic
CSV or authentication failures stop without automatic job retries; transient
network failures retain bounded retries. Settings distinguishes invalid keys,
missing permissions, rate limits and provider outages.

Before the first snapshot exists, Home offers the same first-sync progress and
recovery actions as account settings. Keep the App open during synchronization.
A successful task, ready JSON status and a healthy worker are technical checks;
the owner must still compare the real account totals before completing setup.
