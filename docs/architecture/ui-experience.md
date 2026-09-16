# Portfolio workspace experience

## Product intent

Trading Max is a private, read-only portfolio intelligence workspace. Users need
to understand what they own, separate investment performance from cash movements,
revisit account decisions, and research securities using identifiable evidence.

The September 2026 rebuild takes this product intent as its design input. All
previous presentation components, page compositions, chart configurations, and
styles are removed. The new implementation lives in `apps/web/workspace`.

## Information architecture

| Workspace | Questions and interactions |
| --- | --- |
| Overview | Account value, cash, unrealized P&L, history, invested allocation, account and security entry points |
| Holdings | Account filters, search and sort, position details; companies, countries, industries and ETF source coverage |
| Performance | Money and contributions, rebased portfolio and benchmark returns, monthly TWR, drawdown and risk statistics |
| Review | Account selection, money reconciliation, realized attribution, trade quality, phases and ending risk |
| Research | A searchable universe and eight independent perspectives: overview, technicals, valuation, fundamentals, financials, analyst estimates, options and journal |
| Data status | Readiness, worker and snapshot status, queued updates, task history and stage details |
| Connections | Broker credentials, optional model providers and per-lens assignments, CFD imports, schedules and personal preferences |

Security research includes a price/volume chart with candle and line modes,
moving averages and actual account trade markers. Financial statements separate
annual and quarterly periods and preserve per-share units. Valuation separates
reported values from forecasts, with scenario comparison, sensitivity analysis and
editable assumptions. Options include expiration filtering, open interest, gamma
proxies and a browsable contract chain. Generated analysis is optional and tied to
the snapshot being viewed. Its panels and generation controls are temporarily
unmounted across the workspace while the AI experience is redesigned. Provider
settings, stored artifacts and the analysis API remain available.

## Visual and interaction system

The workspace restores the original blue brand palette, cool neutral surfaces
and pale blue navigation, alongside the approved T + M mark. Blue identifies
actions and selected views; green, red and amber retain their financial and
status meanings. Dark appearance uses navy surfaces with brighter chart and
text colors. Tabular numbers and explicit labels preserve the same hierarchy
in both appearances. Charts use consistent colors, readable axes, actual time
spacing and visible gaps where observations are missing. Missing amounts remain
unavailable; zero is only shown when the source contains a zero.

The overview groups current value and its history in one portfolio surface.
Holdings allocation is a compact supporting column, with the security count
kept secondary. Accounts and holdings research follow the same desktop column
boundary in a shared surface. Narrow layouts give the history chart the full
width; phones present supporting metrics as labelled rows. Sections grow with
their content instead of imposing equal card heights.

A labelled navigation sidebar gives way to a bottom navigation and focus-trapped
menu on small screens. Search supports keyboard selection. Filter state updates
the URL. Tables scroll inside their own focusable region; position details,
connection forms, and task details use drawers. Native controls and the component
library provide focus management. Reduced-motion preferences disable decorative
movement. Loading, empty, unavailable, pending, failed and successful states have
specific feedback and an appropriate next action.

Workspace copy names tasks, data and states directly. Product positioning and
privacy promotion belong in the README and website, not in persistent badges,
page slogans or decorative footers. Connection forms retain the operational
details about permissions and model-provider requests. Global search
has one visible entry per layout: the desktop sidebar or the mobile header.
Results distinguish pages, the research list and the action to search holdings;
local list filters name their scope separately.

Treat secondary copy by its purpose, not its color. Delete repeated labels,
normal-state reassurance, interface tutorials and descriptions of implementation
decisions. Prefer precise titles (account valuation, realized P&L attribution,
scenario valuations) to explanatory subtitles. Use concise contextual help for
definitions such as diluted cost, GICS coverage and gamma estimates. Keep currency,
dates, report periods, actual coverage limits, form requirements, errors and recovery
actions visible where they affect the user's interpretation or next step. Do not
convert every deleted paragraph into another help button. Research change history
and exact chart records retain relevant limitations and provenance.

Update schedules expose the three independent runtime controls: live account and
intraday history, performance calculations, and research with daily reconciliation.
Compatibility aliases do not appear as additional switches. Saved account labels
flow through the portfolio, holdings, performance and account-review screens.

The single authored stylesheet is organized by component. Its bounded architecture
budget is 1,000 lines; readable CSS replaces the previous compressed 100-line
budget. Theme, snapshot-boundary, API-lens and ECharts-lifecycle checks remain in
place. The shared chart lifecycle and data/locale services are infrastructure,
independent of the removed presentation layer.

## Compatibility, privacy and rollback

Existing route addresses and typed backend contracts remain available. No database,
configuration or credential migration is required. Trading 212 account ingestion
and the Yahoo Finance-compatible research adapter remain the data path. There are
no trade execution controls. CFD realized equity proxies are labelled separately
from current broker NAV, and intraday value changes are not presented as TWR.

Connection forms keep candidate credentials in component memory, require a
successful test before saving, invalidate the test when input changes, and clear
credentials when closed or saved. Runtime data, imports and credentials remain
outside Git. Reverting the frontend commit restores the previous application
without reverting or migrating account state.

## Verification

Development uses an isolated synthetic state directory and loopback API/web ports.
Representative research artifacts and account reviews come from synthetic data;
no real broker credentials or account screenshots are used. Browser verification
covers primary routes and inner views, charts, filters, drawers, tables, settings,
keyboard navigation, languages, appearances, and narrow layouts. Live broker and
model-provider authentication requires the user's credentials and is not exercised
by the synthetic preview.

The automated checks include frontend type/lint checks, bilingual coverage,
financial presentation tests, existing domain tests, generated API consistency,
architecture checks, a production build, the backend suite, and repository release
and hygiene checks. Browser regression specifications also cover navigation state,
credential-form gating, keyboard search, error recovery and accessibility.
