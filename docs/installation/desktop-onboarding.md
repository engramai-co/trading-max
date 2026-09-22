# Desktop onboarding

Status: **internal desktop preview** on the current **1.8.0** application base.
The entry flow is being integrated in small, independently accepted steps.
There is no signed public desktop installer yet.

Trading Max's desktop entry has three destinations:

| Destination | Current capability |
| --- | --- |
| Create a local workspace | Entry is visible; real local enrollment is the next step. |
| Open an existing workspace | Entry is visible; compatibility checks and local opening are the next step. |
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

## Next: a real local workspace

The next increment connects the create/open entries to a validated local data
directory, read-only Trading 212 setup, the first refresh and readiness checks.
Credentials are entered only through Settings and stored in the operating
system credential manager. Existing directories must be inspected before any
write or migration. Models are optional and currently used for security-name
resolution, not automatic portfolio analysis.

Acceptance requires a healthy worker, a successful first refresh and plausible
broker totals. A rendered page or HTTP 200 alone is insufficient. App closure,
recovery and collection choices must be explicit; hidden login services are not
part of this increment.

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

Before a public desktop release, complete real local onboarding, Developer ID
signing/notarization, signed updates and installation acceptance on a Mac without
development tools. A virtual machine is not required for the current local
preview acceptance.
