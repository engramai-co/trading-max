# Desktop UX surfaces

Status: implemented for the 1.10.0 internal desktop preview. Browser routes keep
their existing presentation. A remote service opts in only when its web release
advertises desktop presentation version 1.

## Motivation and decision

Daily portfolio work, application preferences, source selection and operational
work have different lifetimes. Keep one investment workspace and give the other
tasks focused windows without duplicating financial calculations or forms.

| Surface | Entry | Responsibility |
| --- | --- | --- |
| App settings | Trading Max → Settings, Cmd-comma | Saved startup preference, active source, manual version check. |
| Workspace picker | File → Switch workspace, Cmd-Shift-O | Recent local folders, saved HTTPS service, create/open/connect and explicit demo. |
| Investment workspace | Main window | Shared overview, holdings, performance, research and review; compact activity status. |
| Workspace settings | Workspace menu, Cmd-Option-comma, sidebar utility | Shared account, market-data and optional model connections, schedules and preferences. |
| Sync and activity | Workspace menu, Cmd-Shift-J, sidebar status | Per-scope update outcomes, task stages, update controls and expandable diagnostics. |
| Import records | File menu, sidebar utility | Trading 212 CFD CSV selection, confirmation, result, deduplication and next-step navigation. |

Closing auxiliary windows leaves the investment workspace and its owned runtime
running. Reopening an existing service window preserves unsaved fields; deliberate
links to a section carry query parameters. Source changes close service windows
so a previous workspace cannot remain editable. From 1.15.3, remote outages retain
already opened windows and their fields, with a native connection notice in the
workspace title band. Reconnection never navigates or steals focus; the notice
reports connectivity, not data freshness. Local runtime failure still returns to
its recovery entry.
Main-window close/quit still stops owned local services, never a remote collector.

## Presentation contract and browser compatibility

The web service exposes a read-only `/api/desktop` response with
`service: trading-max-web` and `desktopPresentation: 1`. The native driver checks
this once per connection, with a bounded response and redirects disabled. From
1.15.3 it shares the health-check connection pool and its 15-second connect /
30-second request deadlines. Unsupported or unreachable capability endpoints fall back to
the existing website without preventing a valid service connection.

`/desktop` and its explicit report/settings/activity/import routes compose the
existing business components. A shared link adapter preserves filters and routes
between these surfaces. Normal `/`, `/settings`, `/health` and all other browser
routes do not opt in through a cookie, user-agent or saved preference. Their
navigation and shared styling are unchanged. Desktop CSS is scoped and loaded
only by the desktop layout. The same palette, typography, form controls and chart
components serve both presentations.

App preferences are distinct from service-owned settings. Locale, account labels,
timezone and model/account configuration retain their existing storage and API
ownership. No native form reimplements a connector. A settings menu open does not
submit any configuration, start a refresh or launch a second runtime.

## Security and state ownership

Only bundled `main`, `settings` and `workspaces` windows at `tauri://localhost`
accept native commands. The external investment window and all three service
windows are excluded from capabilities, including when they display loopback
content. They receive no script injection, filesystem, shell or Keychain bridge.

Normal same-origin links to a fixed allowlist of desktop routes can focus a
service window or return to the main investment window. This chooses presentation
only. External links open in the system browser; unknown routes cannot request a
native action. Window navigation is bound to the selected origin and connection
generation, and stale callbacks cannot reopen another workspace's windows.

Existing connection profiles, local folders, recent entries and credentials are
preserved. Startup preference updates read the newest saved profile and modify
only the auto-open flag. Temporary demonstrations do not replace the startup
service. The isolated demo remains read-only, including its import UI. Empty
workspaces retain first-sync/broker-total confirmation gates and contain no fake
account history. An imported CSV remains saved while the prerequisite account
sync is incomplete.

## Activity semantics

Connection availability, worker readiness and successful business tasks are
separate states. Desktop activity checks the latest result per scope, including
schedule records outside the short recent-jobs list. A successful balance refresh
does not clear failed account-history or performance work. The same scope must
succeed to supersede its earlier failure. Historical cumulative failure counters
are not presented as current failures. Task details and the next recovery action
remain visible while the last published investment snapshot stays readable.

## Alternatives and deferred work

Reusing the welcome wizard as Settings leaves daily actions ambiguous. Splitting
every investment report into a window complicates context and lifetime. Native
copies of connection forms would duplicate validation and financial ownership.
These alternatives are avoided. Public signing/notarization arrived in 1.11.0;
[in-app updates](desktop-in-app-updates.md) are a separate 1.12.0 capability. Mobile
access, background collection and optional security pop-outs remain deferred.

## Validation and rollback

Use synthetic local fixtures for browser and desktop acceptance. Compare the
previous release and candidate browser navigation and layout for overview,
holdings, performance, research, review, settings and health. Exercise desktop
routing, old-service fallback, guarded native origins, repeated window opens,
independent close, workspace switches, manual update checks, failure visibility,
invalid/duplicate CSV imports and first-sync gating. Verify keyboard and accessible
controls, dark/light appearances and the installed App's actual screenshots.

Run the CONTRIBUTING checks, native Rust/Python/JavaScript tests, and the packaged
runtime harness. Verify the bundle remains immutable and retain a verified prior
bundle externally. Rollback replaces the stopped App; any newer local-workspace
startup follows the existing verified recovery policy. No data or credential
migration is introduced by the UX split. A local candidate is not a public signed
installer or evidence that every production broker job succeeded.
