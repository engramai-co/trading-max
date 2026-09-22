# Desktop onboarding

Status: **internal desktop preview** on the current **1.8.0** application base.
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
