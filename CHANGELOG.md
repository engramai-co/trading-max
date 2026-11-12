# Changelog

All notable public Trading Max releases are recorded here.

## [Unreleased]

## [1.33.0] - 2026-11-12

### Added

- The research desk charts daily trailing P/E for covered US stocks: diluted
  EPS from SEC filings, effective from the first close after each filing, with
  split-adjusted Yahoo closes. The chart shows the 25th–75th percentile band and
  median (or mean ±1σ), plus the latest value and its percentile. The yearly
  filing points remain.
- App Settings → General offers 中文 / English for the App's own pages.
  Simplified Chinese is the default, whatever the macOS language.

### Fixed

- The desktop welcome screen marks recent workspaces whose folders were removed
  as unavailable, and opening a removed folder no longer recreates it.

## [1.32.1] - 2026-11-12

### Changed

- Returns & Risk leads with period net P&L, then account value and net
  contributions, then drawdown, matching the figures above the chart.
- The lead colour in holdings allocation is blue slate; cobalt stays reserved
  for controls and selection.

### Fixed

- History legends list only the estimates and gaps actually drawn, and shaded
  areas stop at real gaps instead of bridging them.
- Trading 212 sync paces requests to the broker's documented limits, honours
  Retry-After and retries rate-limited cash history pages, so a sync started
  right after a failure no longer runs into "too many requests".
- Account value rebuilds reuse a confirmed market listing instead of
  downloading other listings again; London fallbacks still work.
- Unavailable Yahoo fundamentals are reported as missing instead of failing,
  and another share class is never substituted.
- The desktop demo's history covers whole weekdays, so its charts no longer
  show a gap every night.

### Added

- A read-only backend foundation for a future valuation agent: listing-scoped
  public evidence, citation checks and deterministic replay of the research
  desk's valuation. No visible change.

## [1.32.0] - 2026-11-12

### Added

- Pages refresh by themselves. While a page is open, Trading Max checks for a
  newly published snapshot about once a minute, and right away when you return
  to the window or reconnect. The page then updates in the background: the
  previous figures stay until matching new ones arrive, and numbers, charts and
  times change together. A chart you are reading and unsaved valuation edits are
  left alone. When two checks in a row fail, the existing "update failed · last
  success" note appears.

## [1.31.2] - 2026-11-12

### Fixed

- Account updates no longer fail after 1.31.1 counted uninvested pie cash
  that Trading 212 leaves out of the account total. Cash reserved for pending
  orders still counts; pie cash counts only when the total includes it. Daily
  values saved by 1.31.1 reconcile on the next update.

## [1.31.1] - 2026-11-11

### Fixed

- The first account sync no longer fails its balance check when Trading 212
  holds cash for pending orders or in pies. That cash now counts as account
  cash, so cash plus holdings matches the broker's account total.

## [1.31.0] - 2026-11-11

### Added

- The Trading 212 connection form explains how to create a read-only API key
  for each account and choose the matching account environment.

### Changed

- The desktop demo labels its synthetic data, shows the snapshot date, and
  includes ten holdings across Invest and Stocks ISA and a US sector board.
- The desktop welcome screen shows the app version and supports English and
  Simplified Chinese.

### Fixed

- Chart labels at the ends of the horizontal axis stay inside the plot in
  smaller windows, and the US sector empty message wraps more evenly.

## [1.30.2] - 2026-11-11

### Changed

- Holding details lead with market value, portfolio weight and gains or losses.
  UK pence quotes show in pounds beside the cost figures, with the original
  quote and conversion under Quote and calculation. Funds link to look-through
  exposure.

### Fixed

- Zero changes use neutral text instead of gain colours.

## [1.30.1] - 2026-11-11

### Changed

- The overview, holdings, returns, research and review use quieter loading
  placeholders. Returns keep the last complete figures and charts in view
  while a new period or account loads.

### Fixed

- Research no longer flashes a missing price while reading a quote. Charts
  update in place and respect the system's reduced motion preference.
- If a refresh fails, the last good readings stay visible with a retry beside
  the data time.

## [1.30.0] - 2026-11-11

### Changed

- Money & P&L leads with signed net profit or loss and shows how opening value,
  contributions and P&L add up to ending value.
- The taller P&L chart shows a zero line and clearer ticks. The drawdown chart
  marks the worst decline and shows when it recovered, if it did.
- The percentage view is now called “% of opening value”, because it divides
  the change by the opening value and is not an investment return.

## [1.29.4] - 2026-11-11

### Added

- Research now keeps a dated record of analysts' earnings estimates for held and
  watched securities, so forward P/E history can be charted later.

### Changed

- Scheduled research updates now cover every security held in Invest and Stocks
  ISA as well as the watchlist. The saved watchlist does not change.

## [1.29.3] - 2026-11-10

### Fixed

- The overview and other pages that load larger data work again in browsers.
  Since 1.29.1 they could fail to read their data and show an error instead.

## [1.29.2] - 2026-11-10

### Fixed

- Centred Chinese messages sit on their visual centre, even when they end in
  full-width punctuation.
- Chinese research and sector text has clearer spacing around Latin letters
  and digits. Short product names stay together across line breaks.

## [1.29.1] - 2026-11-10

### Fixed

- The overview now reports whether each holding is a fund, including after an
  intraday broker refresh. Funds continue to show no company research scores.
- The app closes old log files when logging is reconfigured.
- Updated the PDF reader used for fund documents to fix security issues.

## [1.29.0] - 2026-11-10

### Added

- The overview shows today's US sectors beside the period P&L chart. With a
  mouse, a map sizes each sector by index weight and colours it by the
  session's move; phones and touch screens get one block per sector, largest
  first, each large enough to tap. Every block opens its sector on the Sectors
  page.

### Changed

- The overview's holdings panel combines allocation and research: a donut of
  your largest holdings beside one table of weight, the latest session's move,
  unrealized P&L, technical score and model upside. Each row's dot keys its
  segment, and the remaining holdings share one row. Readings past their
  thresholds are marked on their cells for up to four holdings; the panel's
  help gives the thresholds. Funds show no research scores yet.
- The overview's attention list shows only data problems: failing updates and
  account data that stopped arriving. The Invest and ISA, allocation and
  research panels left the overview; account review keeps per-account figures.
- The dashboard API marks each holding the look-through treats as a fund
  (`isFund`), including a fund whose issuer holdings are unavailable or do not
  reconcile. The look-through records those positions as `fundPositions`.

### Fixed

- In the dark theme, sector colours stop at a slightly lower strength so their
  figures keep their contrast.
- Clicking a security's hover preview no longer opens the link beneath it.

## [1.28.2] - 2026-11-09

### Fixed

- A sector board left without official closing prices no longer stays that way
  when the service starts long after the market's close, as after a restart or
  an outage: the session is tried again a few times and settles once the
  closes arrive. A market whose stored board is from an earlier session is
  filled the same way.

## [1.28.1] - 2026-11-09

### Added

- The research desk's price chart offers YTD between 3M and 1Y without opening
  the full chart. On touch phones the seven ranges keep one row where seven
  44px cells fit and otherwise take rows of four and three.

## [1.28.0] - 2026-11-09

### Added

- A Sectors (板块) page shows how far each sector of one market has moved in
  the current session: US (S&P 500), UK (FTSE 100), Hong Kong (the HKEX-listed
  names of the MSCI AC Far East ex-Japan index) and Korea (MSCI Korea). A map
  sizes sectors by index weight, nests GICS industry groups inside them and
  colours both by the session's move; each sector carries its breadth and how
  many sessions in a row it has ranked in the top three. The selected sector
  shows its intraday line and high, up and down counts, leader, ranks over the
  last five sessions, your look-through exposure, and its industry groups and
  companies, with links into research. Phones get a ranked list that opens a
  sector as its own step.
- The US board can group by your research themes (three or more priced
  members) instead of GICS sectors.
- With Research automatic updates on, sector boards refresh every 10 minutes
  while each market is open and settle on official closing prices after the
  close. Constituents and weights come from iShares fund holdings; prices come
  from Yahoo Finance in batches of twenty symbols. A failed or incomplete
  refresh keeps the last board and is flagged beside its time; Data status
  lists the next sector update.

### Changed

- The mobile dock holds six pages. Its English labels are shorter so they fit
  a 320px phone: Home, Assets, Returns, Sectors, Stocks and Review.
- The Research automatic-update setting now also describes the sector
  refreshes it controls.
- The desktop App opens links to Sectors in its workspace window.

## [1.27.0] - 2026-11-06

### Changed

- Phones (narrower than 768px) use the Quiet Ledger rhythm: 24px between
  sections, 16px inside panels and 12px from a heading to its content. Body,
  table and list text is 13px, labels are 12px, and text uses three weights
  (400, 500, 600). Desktop, tablet and the desktop App window keep the 1.26.0
  spacing and type.
- On phones the overview shows floating P&L and cash side by side, with the
  account selector and data time on one row; a figure too long to share a row
  takes its own, and the portfolio value scales down on the narrowest phones.
  The research identity, the holdings summary and the settings connection
  cards drop their boxes. The overview chart, the research price chart and the
  review angles move up the first screen.
- Phone analytics metrics pair up while their figures fit; an estimated period
  P&L takes the whole row so its tag and help stay on one line.
- The phone account review keeps its account selector beside a short title and
  gives it the full row under a long one, so the account name is never cut.
- Phone controls reach 44px touch targets: selects, buttons, info buttons and
  estimate tags, the overview's attention and day-driver links, disclosure
  summaries and the update-schedule switches.

### Fixed

- On phones, the overview's day drivers, the analytics P&L tag and help, and
  the risk cards' review links no longer share hit areas with neighbouring
  controls.
- The phone analytics returns figure no longer runs past its column.

## [1.26.0] - 2026-11-05

### Changed

- A recent decision on the review index opens the account review on that
  decision. It leads the decisions panel with its effect (or 观察中 and the
  trading days so far), opens on 至今 while its 20-day window is incomplete,
  is ringed on the timeline, takes focus once on arrival and clears with one
  button. A link that no longer matches, or matches two securities, opens the
  normal review.
- The account review keeps its angle in the address (`reviewView`), so a
  refresh, Back or a shared link reopens it, and each decision keeps its own
  horizon.
- Decision counts describe outcomes in the words their effect takes:
  "赚 170 / 325 次" for buys and "少亏 120 / 251 次" for sales. The hindsight
  panel reads 与持有期最高收盘对照. The decisions help is three short
  paragraphs, and the panel title that repeated the selected tab is kept for
  screen readers only.
- Phones: the account review compacts its summary and highlights so the angles
  and their first figures fit the first screen. Look-through leads with
  companies: search sits beside one 筛选 control for country, sector and
  ownership (with a count), and sort beside the view switch ("Rank | Mix" in
  English).
- Settings: one Alpaca 增强 switch replaces the status tag and its button, and
  Alpaca writes run one at a time. The CFD import drops its repeated heading
  and names its file control in every state. A failed reload keeps the page and
  offers 重试.
- Research 财务与业务 drops the period title beside the period picker and the
  second currency label.

### Fixed

- The phone look-through pagers above and below the list have distinct names
  for assistive technology.
- The Alpaca switch and 清除筛选 have 44px touch targets, and saving is
  announced.

## [1.25.0] - 2026-11-04

### Changed

- Decision review leads with the evidence. The 买卖决定 totals, horizon switch and
  timeline come first; the AI review follows as its headline and summary, with
  the evidence, 下次决定前 and 保留意见 behind one disclosure. With no review yet it
  is a single row with 生成复盘. On a phone, 买卖决定 starts about a screen higher.
- A decision's "+N" is a button that lists the events that did not fit, by tap,
  click, Enter or Space; Escape returns focus to it. Each row stays one link to
  the research view, its outcome is announced once, its text can be selected,
  and it keeps keyboard focus when a refresh changes its context.
- The research desk shows the selected security once: its name opens the
  research list, and 更新 and ⋯ share one tool row. On a phone the 3-month price
  chart fits the first screen.
- Touch screens: research tabs, segments and period controls are at least
  44×44 with no gaps between them; the eight periods take two rows of four when
  one row cannot hold them at that size. The look-through list shows 25 rows per
  page on phones, with the pager above and below the list.
- Research figures in Chinese use 亿 and 万 with four significant digits, and
  chart axis ticks stay distinct. English figures are unchanged.
- Fewer repeated labels: valuation reads 营收 and 现金流率 under its TTM heading,
  the 对总分的影响 caption moves into the 技术诊断 help, the journal drops its second
  研究笔记 title, and an empty journal reads 暂无笔记 beside 写笔记. The technical
  lens period 全部记录 reads 全部, like the portfolio periods.

### Fixed

- Help popovers and the regenerate confirmation move keyboard focus inside when
  they open and return it on Escape.

## [1.24.0] - 2026-11-04

### Changed

- Decision review speaks plainly: buys read 赚/亏 and sales 少赚/少亏 against
  holding, with "N / M 次卖对了". The summary shows the round-trip result in place
  of the hindsight figure, which moves to its own panel above the round trips, so
  the page ends on decisions. Round trips and best closes show their five largest
  rows and keep the rest behind one disclosure.
- Decision rows keep the effect, date, amount and later change beside the arrow
  at every width (narrow columns give the details their own line); the S&P 500
  move and company events fit one line that collapses into +N. Analyst ratings
  and SEC filings read in Chinese.
- Decision review counts only completed closes from each listing's exchange
  calendar and final daily exchange rates. Each decision states how many closes
  followed it (`observed_days`, `horizon_complete`, `decisions-v4`). A decision
  with no completed close after it is observing: the review index counts every
  one ("观察中 N 笔", `observingCount`) and they are neither scored nor plotted as £0.
  A price or rate the provider has not published keeps a decision observing for
  up to three later sessions, then settles on the last value before the gap;
  weekends and currency-market holidays use the last business day's final rate.
  Effects may be restated if the data provider corrects its history; the help
  and the data guide say so.
- The S&P 500 comparison runs between the security's own closes on the New York
  calendar and waits until the index has a completed close for the same day.
- The account review states once when its figures were built, with the time
  (`reviewAsOf`). The AI review shows when it was written only when that is
  older than the figures, cannot be generated or replaced while a stored review
  is still loading, asks before replacing one, and writes Chinese dates as
  2025年8月21日.
- Data status names each failure cause with "之后已成功 N 次 · <time>"
  (`succeeded_after` and `last_success_at` on failure causes, ordered by completion)
  and keeps the raw message in a 技术详情 disclosure. A healthy service leads with
  the last successful update and shows the schedule beside the update form.
- Fewer secondary labels across review, data status and settings: 全部账户,
  本次结论, table record counts, 无需 API 密钥, the CSV helper sentence, the
  retired-account tag, the plug icons and the 查看数据状态 button are removed. A
  retired CFD account leaves the review index, connection tags are neutral and
  the ISA has one name. The CFD review's caveat and the estimate tags are inline
  tags that open their explanation from the keyboard and touch.
- Decision prices are cached by completed sessions (cache format 3), take the
  exchange from the history response itself, and fetch a late final bar again
  within six hours. review.tsx is split into smaller modules.

### Fixed

- The account review's evidence area is a labelled section, the decision
  scatter legend shows the gain and loss colours, and behaviour analysis lists
  observations as aligned rows.

## [1.23.0] - 2026-11-04

### Added

- Today is the overview's first answer: the third header cell shows today's net
  P&L in GBP and percent with the positions that moved it most. The previous
  trading day's return moves into its help; on weekends the cell names the
  trading day it shows. While new cash flows await reconciliation it states
  where its figure stops ("截至 09:00", in the display time zone).
- Holdings show each position's change since its account's first observation
  of the trading day (`dayChangeGbp`, `dayChangePct`), measured at the same broker
  observation for the same broker instrument: a sortable today column on
  desktop once values exist, and today and unrealized P&L in GBP on phone cards
  and in the position detail.
- ⌥ (macOS, iOS) or Alt (Windows) with 1–8 switches the overview and
  performance chart ranges; Linux browsers and ChromeOS keep those keys. The
  overview reopens on the range last chosen on the device, and a range in the
  link still wins.
- History requests accept up to two exact attribution openings (`opening=`)
  and answer the cash-flow-adjusted P&L at each, from unthinned observations.

### Changed

- The 1D and 5D "What moved" strips only explain the figure they sit under:
  they wait while the figure is cut off, state a later start ("since 08:10")
  and measure it from the exact P&L at that opening, and hide when openings are
  earlier than the figure or differ between accounts.
- The day attribution (`day-attribution-v4`) records the broker instrument and
  opening value of each contribution and opens each account's trading day at
  that account's own first observation of it.
- Phones reach data status, settings, language and appearance from one More
  menu; the drawer that repeated the dock is gone.
- Quieter overview, holdings and performance pages: duplicate shortcuts, panel
  titles, captions and legend entries are removed; explanations move into help
  and chart controls share one row.
- Tabs and segments animate their selection with transform only, level with
  the tabs.

### Fixed

- When one account syncs into a new trading day before another, the lagging
  account's first observation of that day no longer reports the move since its
  previous trading day as that day's change. Attributions opened on another
  trading day, including ones written before this fix, are left out.
- Today labels change at midnight in the display time zone and when the page
  is shown again; with reduced motion, navigation icons no longer cross-fade.
- Monthly return pills keep 4.5:1 text contrast; top-bar menus contain only
  valid menu items; record pagination is a named navigation landmark; table
  corner headers and holding weights are named correctly; labels with tags no
  longer break Chinese text into a column on phones.

## [1.22.0] - 2026-11-04

### Added

- One price for each held security on the research desk. When the broker line is
  the research quote's listing (same market, symbol and currency), the header,
  holding value, analyst-target upside, spot and multiples use the broker price
  the holdings page shows. Other lines, `.L` aliases and several lines under one
  ticker keep the research quote. The research shell reports `directValueGbp`,
  `brokerPrice`, `brokerPriceCurrency`, `brokerAsOf` and `brokerListing`; valuation
  previews report `spotSource` and `spotAsOf` and keep the research data version
  for edit conflicts.
- Research quotes carry their exchange's session schedule (`listing`, `schedule`,
  `until`). Closes, the daily change and lateness follow each exchange's
  calendar, holidays and early closes; a close that a newer session has passed
  shows as an amber session-close tag instead of "延迟 20 分钟", and times follow
  the display time zone. Exchanges without a known calendar make no session
  claims, and a page that outlives its calendar stays marked out of date and
  fetches the research again.
- One next report date (`nextEarningsDate`) across the research desk, never in the
  past in the exchange's own time zone; open pages refetch as that date turns.

### Changed

- Exposure and portfolio impact use current direct values and revalue fund
  contributions by each fund's current value.
- The look-through page shows one line with its underlying count and data time,
  names coverage only below 98%, drops the portfolio-wide rankings block and the
  details title, keeps its filters in one row, pages by 100 rows with a show-all
  switch, and names countries and GICS classes in Chinese (Taiwan and Taiwan
  Region count as one place).
- The research overview's panel titles open their lens, the business excerpt
  opens the full description, and the technical lens drops the repeated state
  line, per-group tags, the daily label and the single-series legend.
- Valuation edits the selected assumption in its own row. Previews of held
  securities follow a broker price refresh, keep edited assumptions, and keep the
  editor and its last preview with an inline retry when a refresh fails.
- Research lenses use short labels on phones, and J/K step through the research
  list. research.tsx, research-valuation-workbench.tsx and the look-through view
  are split into smaller modules.

### Fixed

- The option chain shows "—" for contracts without a bid or ask, keeps their
  placeholder volatility out of the charts, and names its columns in the reading
  language.
- Estimate periods always show their year, the currency appears once per panel,
  and the growth reference names the fiscal year of its consensus. Seasonality
  shows sample counts only below five, in amber, and marks the selected month in
  the brand colour. Holding value and the median target are no longer coloured
  as gains.
- Statement value buttons and filing links have descriptive accessible names;
  technical diagnosis groups use the accordion heading pattern.
- The look-through details keep a heading for the open dimension, so heading
  levels stay in order after the details title was removed.

## [1.21.3] - 2026-11-04

### Fixed

- A security without a logo no longer produces a failed request in the browser
  console: the logo route answers 204 and the mark shows the ticker monogram.
- The pointer-only security preview no longer puts popup roles on a plain
  wrapper (axe `aria-allowed-attr`), and paginated record tables label a
  navigation landmark instead of a role-less element.

### Changed

- The dashboard lens `detail` parameter now documents its cost in the
  OpenAPI contract and API guide: interactive clients and agents should pass
  `detail=summary`; the compatible `full` default also embeds the complete
  history.
- The installed model-bridge test is skipped with a clear reason when the
  bridge dependencies are not installed locally (`npm run llm:install`); CI
  always runs it.

## [1.21.2] - 2026-11-04

### Changed

- The web stylesheet is split into ordered surface files under
  `apps/web/app/styles/`, formatted one declaration per line; `globals.css`
  only imports them in cascade order. The compiled CSS is unchanged apart from
  whitespace. The architecture check now enforces the manifest, 900 lines per
  file, one declaration per line and 160 characters per line. Two fully
  overridden duplicate rules were removed.

## [1.21.1] - 2026-11-03

### Fixed

- AI review read a sale's positive effect as a rise the owner missed. The
  review now states how every effect is signed (positive means the decision
  helped, whichever the side), names accounts instead of letter codes and
  calls same-day round trips 日内做 T in Chinese.
- A decision whose effect rounds to £0, such as one made today, is no longer
  shown in green as if it had helped.

## [1.21.0] - 2026-11-03

### Added

- Smart decision review. Each decision the review lists now shows the S&P
  500's change over the same window, to separate the market from the
  security, and the company events around it: results with their EPS
  surprise, analyst upgrades, downgrades and initiations, filings and recent
  headlines. Events are cached per listing and limited to a few telling ones.
- AI review on the decision review page: on request, a configured model
  reads this account's decisions, outcomes, market moves and linked events
  and writes the recurring pattern, the evidence, caveats and what to check
  before the next decision. It runs only when the owner asks, independently
  of the automatic analysis switch, and stays readable after later
  snapshots.

## [1.20.0] - 2026-11-03

### Added

- Decision review scores same-day round trips (T): the shares bought and
  sold on one day are one round trip, worth (average sell − average buy) ×
  shares after costs, shown against the day's high-low range on the same
  shares. Only shares bought or sold beyond the round trip still count as a
  buy or sell decision.
- Buy and sell effects include the dividends paid after the decision: a buy
  earns them, a sale gives them up.

### Changed

- The decision price cache also keeps each day's dividend, high and low;
  older caches are fetched again once.

## [1.19.0] - 2026-11-03

### Added

- The overview's 5D range now shows what moved the account, like 1D: the
  largest position contributors, the rest, and an unattributed share when it
  is material. The five trading days' openings are chained, so trades between
  days are attributed from the next opening and only trades within a day stay
  unattributed. Openings missing from earlier snapshots are rebuilt from the
  broker's own observations of that day.

## [1.18.4] - 2026-11-03

### Changed

- The desktop connection screen keeps headings and choices only: the
  duplicate top label, the subtitle, the sidebar tagline and the one-line
  descriptions under each choice are gone. A remote connection no longer
  shows a note about server-side collection while it is failing.
- App Settings no longer leaves "update window opened" on screen after the
  native update window reports an error; that window reports progress and
  errors itself.

### Fixed

- The T and M monogram on the desktop connection and settings screens now
  switches to its dark colours in dark mode instead of relying on the SVG's
  own colour-scheme query.

## [1.18.3] - 2026-11-03

### Fixed

- Performance updates no longer fail at US session boundaries. When prices
  move between the broker's account summary and its position detail, the
  update uses the latest reconciled snapshot from the previous 30 minutes; a
  longer or summary-level mismatch still fails.
- The data page's seven-day failure summary separates causes that share an
  error code: connection failures, broker rate limiting, and positions that
  differ from the account summary.

## [1.18.2] - 2026-11-03

### Changed

- On phones, monthly returns read as one block per year with three months
  to a row instead of a thirteen-column table that scrolls sideways.
- On phones, the overview's attention chips stay on one scrolling line
  with a fading edge instead of stacking one per line above the chart.
- On phones, the full statements table gives line items a narrower,
  wrapping column so more periods fit beside it.

## [1.18.1] - 2026-11-03

### Changed

- The estimates and events lens opens with its conclusions: analyst
  consensus and coverage, the median target against the price, the
  quarter's EPS estimate change over 90 days with recent revisions, and the
  next report date with last quarter's surprise.
- Estimate revisions keep their chart and move the exact readings and
  revision counts under one disclosure; quarterly EPS axes and readings
  show month and year instead of raw dates.
- The financial workbench's headline figures carry their comparison:
  prior-period revenue and growth, the margin change in percentage points
  and free cash flow as a share of revenue. The operating history table
  sits under a disclosure beneath its chart, and the revenue-to-net-income
  bridge labels each step on the chart instead of repeating it below.

## [1.18.0] - 2026-11-03

### Added

- Account review opens on **Decisions**: every buy and sell, one security
  and side per trading day, compared with what the price did next. A sale
  counts against you when the price rose afterwards and for you when it
  fell; a purchase counts the change of the shares bought. Totals are shown
  twenty trading days later or to date, with a timeline of every decision,
  the sales and purchases that mattered most in each direction, and closed
  trades against their best and worst close while held.
- The review index shows each account's sale and purchase results after
  twenty trading days and the most recent decisions across accounts.
- A new full-update stage resolves split-adjusted GBP closes for every
  traded security after reconciling each listing with the broker's own
  fills, caches them outside Git, and remembers each accepted listing.
  Securities without reconcilable prices are listed and left out.

### Changed

- Review figures read as whole days and counts instead of raw decimals,
  trade lists drop the redundant direction and empty fee notes, the
  without-best-trades view no longer draws its table twice, and single-page
  tables no longer print their record count.

## [1.17.3] - 2026-11-03

### Added

- The data page's update history opens with the last seven days: one
  quiet line when every update succeeded, otherwise the failure count and
  rate, and each cause with its update type, count, latest time and latest
  message. Operator cancellations are not counted as failures.

## [1.17.2] - 2026-11-03

### Fixed

- Opening the overview right after a live update no longer waits two to
  three seconds. When a new snapshot is published, the service now builds
  its history index as well as the dashboard, checks for new snapshots
  every three seconds instead of fifteen, and the web server prepares the
  three-month and one-day views of the period chart ahead of time.
- Moving between chart ranges and accounts keeps up to eight prepared
  history views instead of two, so returning to a range is instant.

## [1.17.1] - 2026-11-02

### Fixed

- Live and full account updates now run the day attribution stage, so the
  overview's 1D line appears. The stage was registered in 1.17.0 but left
  out of the job plans.

## [1.17.0] - 2026-11-02

### Added

- On the overview's 1D view, a line under the period P&L shows what moved
  the account today. It lists the three largest position contributors since
  the trading day's first observation, then "Other" for the rest, and the
  parts add up to the account change. Each ticker links to its research
  page. When cash, FX on cash, trades during the day or valuation timing
  explain a large share of the move, an amber "Unattributed" tag says so.
  The trading day follows London time; weekends stay on Friday, as on the
  1D chart.
- Live account collection keeps the day's opening position values, so
  attribution needs no extra market data. Accounts whose position detail
  does not reconcile with the broker summary are left out instead of
  estimated.

## [1.16.4] - 2026-11-02

### Fixed

- The look-through page no longer hits a render loop when the device's
  pointer changes while it is open, for example when a trackpad is
  attached to a tablet. Security previews share one pointer check for the
  whole workspace instead of one per row.
- A selected tab near the edge of a scrolling tab row is scrolled clear of
  the edge fade instead of stopping half faded.

### Changed

- The option chain opens at the money: on narrow screens the strike column
  is centred between calls and puts, and the strike nearest the spot price
  is centred vertically. The Calls and Puts headings sit beside the strike
  column so they stay in view.
- Statement values and look-through ranking headings have larger touch
  targets without changing the layout.

## [1.16.3] - 2026-11-02

### Changed

- The full financial statements view shows the same small trend bars
  beside each line item as the summary table, oldest to newest.
- Performance and review history charts print the year only on dates
  outside the latest year shown, instead of on every axis label.

## [1.16.2] - 2026-11-02

### Changed

- Reconstructed estimates in the overview's period P&L and in performance
  are marked by a small tag beside the figure, drawn with the chart's dashed
  estimate stroke, in place of the full-width banner above the chart. The
  tag names what is estimated (opening value, latest value or share of the
  period), turns amber only when the estimate sets an endpoint or covers
  more than a quarter of the period, and keeps the full explanation on
  hover.

## [1.16.1] - 2026-11-02

### Fixed

- The remaining raw YYYY-MM-DD dates in research and review now read like the
  rest of the workspace: statement period headers, comparison periods, event
  and filing dates, trade and corporate-event headings, short-interest and
  ex-dividend dates, filing-multiple sample windows, research note save times
  and review phase spans and events.

## [1.16.0] - 2026-11-02

### Added

- Resting the pointer on a security in holdings, look-through, the
  overview's holdings research and review trade lists opens a small preview
  with its latest price, a three-month sparkline and change, and your
  position or exposure. Prices load only when the preview opens; touch
  screens keep the plain tap target.
- Financial statement rows show a small trend bar beside each line item,
  oldest to newest, with the latest period solid and losses below the
  baseline.

### Changed

- The research overview and the account review summary are each one
  surface divided by hairlines, so related sections read together instead
  of as separate boxes.
- Monthly returns use rounded pills whose tint follows the size of the
  move, and month tooltips name the month in words.

## [1.15.9] - 2026-11-02

### Changed

- Show real company and ETF logos across the overview, direct holdings,
  look-through rankings and research universe, falling back to a neutral
  monogram tile only when no logo is available.
- Format research price spans, earnings windows, filing dates, analyst
  period headers, consensus dates and account review spans in the reader's
  locale instead of raw YYYY-MM-DD strings.
- Render research price changes in parentheses (`-4.22% (-US$9.02)`),
  format the account review P&L timeline axis in compact pounds (`£3k`),
  and keep healthy service rows in muted text without green status tags.
- Account review shows money reconciliation and record coverage in one
  two-column panel, with the record span on a single row.

### Fixed

- Option chain open-interest totals and the Put/Call OI ratio now sum
  available contracts when individual strikes omit open interest.
- Clamp the valuation scenario comparison axis at -100% so high-upside
  securities never display an impossible downside below zero.

## [1.15.8] - 2026-10-31

### Changed

- Let the layout carry the explanation across the workspace: drop repeated
  captions, currency suffixes, default-state tags, letter tiles and helper
  sentences that restated what the page already shows.
- Timestamps read as "今天 22:00" or "10月28日 22:00", with the year only when
  it differs; the display time zone is no longer repeated on every value.
- Research opens on the security itself: a switcher with the ticker and name,
  previous/next, comparison and add sit in one toolbar, and the quote line
  names the exchange time zone in words.
- Period P&L on the overview and performance pages shows the dates it
  covers, and the percentage is labelled "相对期初". Returns show one
  portfolio TWR figure and a compact return and drawdown table per series.
- Estimated history speaks up only when it matters: an estimated opening or
  latest value, or at least a quarter of the period. Minor estimates appear
  as a quiet tag, and the chart key for recorded, estimated and missing
  segments appears only when such segments exist.
- Holdings merge the position count into "盈利持仓 n / total", show the
  result count only when filtered, and give mobile rows a weight bar.
  Look-through ranking titles open their detail table directly.
- Review account cards are the link themselves; option chains hide the
  default "latest chain" tag, format contract times and flag partially
  captured expirations; the valuation basis lists readable inputs with
  dated filing links instead of provider field paths.

### Fixed

- Holdings totals for invested capital and unrealised P&L now use the
  account totals shared with the overview, so both pages show the same
  figure.
- Chart labels use the workspace font at 12 px. Canvas text could not
  inherit the page font, so some charts fell back to the browser's 10 px
  default.
- Volume bars start at zero with one label at the period high, and stacked
  chart panes no longer print colliding axis labels.
- A queued research update no longer marks the whole research page as
  loading; the update button alone shows its progress.

## [1.15.7] - 2026-10-28

### Fixed

- Data status no longer reports a ready service as all clear when no update
  has completed for over a day; it states how long ago the last update
  finished and points to updating or checking the schedule.
- Keep the research update button labelled while it runs, and show disabled
  schedules in muted text.
- Holding colours in allocation charts and lists no longer reuse the gain
  green or loss red. Review account cards colour TWR and drawdown like the
  rest of the workspace.
- On touch screens, information buttons and text links get a 44 px tap area,
  and disclosure summaries and their links clear the 24 px minimum.

## [1.15.6] - 2026-10-28

### Changed

- Replace the Trading Max symbol with a solid T and M monogram in the
  workspace's own near-black and cobalt. The stem now stands flat on the
  baseline and the letters stay legible at 16 px and in one colour. Update the
  browser, touch and desktop App icons, the sidebar, the desktop connection
  screen, lockups and social preview. The sidebar and browser icon follow the
  dark appearance.

## [1.15.5] - 2026-10-28

### Fixed

- Show persisted account-history reconstructions during collection outages in
  Overview and Performance, including after broker observations have begun.
  Preserve broker observations and existing display sampling.
- Distinguish reconstructed estimates from recorded values and unresolved gaps
  in chart strokes and hover details. Disclose when money P&L and drawdown
  include estimates; time-weighted return calculations are unchanged.

### Security

- Update Next.js and its ESLint configuration to 16.4.3, refresh the Certifi
  certificate bundle, and update affected Vite, Vitest and Zod dependencies
  to resolve the release dependency audit findings.

## [1.15.4] - 2026-10-11

### Changed

- Simplify the Overview and Performance short-range time axes: show compact
  calendar dates in 5D and rounded local hours in 1D, with shared date and
  timezone context. Adapt label density to narrow screens and keep exact
  observation timestamps in tooltips. Sampling, gaps, weekend folding and
  financial calculations are unchanged.

## [1.15.3] - 2026-10-09

### Fixed

- Keep an open desktop workspace and its current page in place during remote
  connection outages. Show a quiet native connection notice without hiding the
  portfolio, closing service windows or reloading the page after recovery.
- Allow slower HTTPS connections and reuse connections for service checks.
  Retry temporary network/server failures with capped backoff until cancelled;
  permission, invalid service and TLS validation errors remain explicit errors.
  Connection recovery does not imply that account data has refreshed.

## [1.15.2] - 2026-10-09

### Fixed

- Show repeated account or performance update failures in Overview's "Needs
  attention" row, even when live valuations are fresh. The warning links to
  update history, survives restarts and clears after the affected update recovers.
  Check a small read-only status endpoint without delaying portfolio loading.
- Keep account history updating when Trading 212 relabels the merchant
  category or merchant name of an existing card transaction. The newest label
  is kept; any change to amount, time, quantity or action still stops the sync.

### Security

- Update Next.js from 16.3.6 to 16.3.8 for GHSA-cjq9-62q9-8jv4 (image
  optimisation SSRF) and the related cache and disclosure advisories fixed in
  the same patch release.
- Repair the pending 1.9.10 release's lint dependency audit with the pinned
  upstream braces depth-limit patch for GHSA-vfj7-8cjw-p6xm. This same-version
  release correction does not change the running application or backup format.

## [1.15.1] - 2026-10-07

### Changed

- Slide figures into their new value when the account, range or data changes.
  First loads stay still.
- Fade new content in when switching tabs.
- Ping the status dot next to "Data as of" when a new snapshot arrives.
- Slide the mobile menu up instead of cutting to it.
- With reduced motion turned on, stop movement only; fades and colour changes
  remain.

## [1.15.0] - 2026-10-07

### Added

- Show what needs a look today under the Overview totals: account data that
  stopped updating, and held securities with a technical score of 30 or
  lower, an RSI past 75 or below 25, model upside of −20% or worse, or a loss
  of 20% or more against cost. Each security appears once with its two
  strongest readings and opens the matching page. The row only appears when
  something crosses a threshold, and uses data the Overview already loads.

## [1.14.0] - 2026-10-07

### Changed

- Move dark mode to a neutral charcoal palette. Blue is now reserved for the
  brand, selection and charts, in the workspace, charts and desktop splash.
- Slide one shared indicator between tabs and segmented controls. Tab rows
  that scroll sideways fade at the edge that has more to show.
- Draw every disclosure with the same chevron, and reveal its content with a
  short slide.
- Raise the smallest text, chart labels and table headers to 12px.
- Keep the top bar in place while scrolling; the page title appears in it
  once the heading scrolls away. Page headings are smaller.
- Let the first figure lead in the summary strips on Holdings, Performance
  and Review; drawdown figures sit in a compact row.
- Shade monthly returns by size, scale holding weight bars to the largest
  position, and space timeline date labels evenly along the axis.
- Keep the strike column of the options chain in view on narrow screens.
- Offer to add an unlisted ticker to the research list from its empty page.
- Group repeated successful refreshes in the update history, with a toggle to
  show every run.
- Show option snapshot and notebook revision times in the chosen time zone.

## [1.13.0] - 2026-10-07

### Changed

- Give the desktop workspace window a transparent title bar. The sidebar
  reaches the top of the window, search moves into the sidebar, and the page
  title appears in the title bar once the large heading scrolls away. Native
  code keeps the band draggable, including double-click to zoom; the page
  still receives no native capabilities. Takes effect with the next desktop
  release; earlier Apps keep their current layout.
- Follow the macOS appearance in the desktop workspace, matching App
  Settings. Language stays in workspace preferences; the browser keeps its
  language and appearance controls.
- Show recent local workspaces by name, with a button to remove an entry from
  the list without touching its folder.
- Remove explanatory notes from App Settings and the workspace picker, and
  match the activity, import and settings window header to the workspace.

## [1.12.4] - 2026-10-07

### Fixed

- Keep the summary and full portfolio projections of a snapshot cached side by
  side. Moving between Overview, Holdings, Performance and Review no longer
  rebuilds the projection the previous page replaced.
- Build both projections in the background as soon as a new snapshot is
  published, so the first visit after a scheduled refresh does not wait for
  them. Set `TRADING_MAX_DASHBOARD_PREWARM_SECONDS=0` to disable the check.

## [1.12.3] - 2026-10-06

### Changed

- Present technical research as a shared daily-state score with auditable
  contributions. Add a compact score and diagnosis entry to the research
  overview, and combine price charts with expandable trend, momentum,
  relative-performance and volume evidence. Keep seasonality independent.
- Preserve the existing scoring weights, chart controls and historical
  navigation. Keep the score's daily date separate from chart navigation,
  disclose missing or unreconciled inputs, and retain original readings.
- Tighten desktop and mobile layouts without removing factor evidence or
  adding market-data requests to the overview.

## [1.12.2] - 2026-10-06

### Changed

- Add a company composition view to ETF look-through, matching the existing
  country allocation doughnut. Show the twelve largest company exposures,
  group the remaining companies, and retain the complete searchable table.
  Selected companies show both direct holdings and exposure through funds.
- Preserve backend allocation weights and show unresolved or non-security
  assets separately. Keep chart rendering bounded, with keyboard, touch and
  reduced-motion support on desktop and mobile.

### Security

- Update the locked sharp image-processing and source-map-js dependencies to
  their compatible upstream security patches, retaining the dependency audit gate.

## [1.12.1] - 2026-10-05

### Changed

- Refine workspace search with direct links to existing security research lenses,
  ETF look-through, return comparison and risk analysis, plus literal match highlights
  and a clearable, session-only recent list. Reuse the research directory cache;
  searching never adds a security or starts a data refresh. Keep search in the
  top bar beside language and appearance controls on both desktop and mobile.
- Consolidate the five primary destinations into an icon-only desktop rail, with
  names on hover or focus, an outline-to-filled selection transition and a short,
  interruptible active-row transition. Keep management destinations at the bottom
  and a matching mobile dock with persistent labels, larger touch controls and
  a bottom-opening navigation menu. Keyboard navigation, history navigation and
  reduced-motion preferences remain immediate.

### Fixed

- Expose keyboard search selection to assistive technology and open search without
  a modal animation. Preserve Chinese composition and focus restoration.
- Distinguish data sync status from desktop application update checks.

## [1.12.0] - 2026-10-05

### Added

- Add explicit in-app macOS updates using Sparkle, with signed feeds and archive
  verification, a native installation/restart window and the manual DMG fallback.
  The first upgrade from 1.11.0 still requires that fallback to install the updater.
- Reopen the active source after an update without changing startup preferences;
  stop only App-owned local services before relaunch.
- Add a resumable maintainer release driver with retained Apple submission IDs,
  artifact/source verification, private command evidence and native acceptance
  gates before publication. Signing credentials remain in Keychain.
- Compile and test the native updater bridge in macOS CI alongside desktop
  packaging, interrupted-release and permission-boundary tests.

### Changed

- Refresh desktop distribution, onboarding and recovery documentation to separate
  signed installers, binary updates and local workspace startup recovery.
- Keep updates user initiated and preserve browser UX, remote services, account
  credentials and existing data ownership.

## [1.11.0] - 2026-10-04

### Added

- Add explicit official desktop DMG downloads with release-manifest, publisher,
  platform and digest checks, separate from source-only repository releases.
- Bundle offline installation, upgrade recovery and uninstall/data-retention
  help in App Settings, with access to existing local workspace recovery files.
- Add a maintainer gate that verifies the signed/notarized DMG and its actual
  application contents before generating desktop release metadata.
- Add isolated macOS packaging commands for signing every bundled native runtime,
  checking minimal entitlements, rehearsing Hardened Runtime with a development
  certificate, and assembling a DMG after the App passes notarization.

### Changed

- Keep desktop upgrades user initiated through the browser and Finder; preserve
  local workspaces and credentials and leave existing HTTPS services unchanged.
  Automatic binary updates remain deferred. The signed preview's installation
  acceptance uses an isolated profile on the release owner's Mac; untouched-OS
  and minimum-OS native UI coverage are not claimed.

### Fixed

- Build desktop Python dependencies from hash-verified macOS 13-compatible wheels
  instead of inheriting the build Mac's newer OS. Reject incompatible native
  components and external absolute library dependencies before signing and when
  verifying the final DMG.

## [1.10.0] - 2026-10-04

### Added

- Separate desktop App preferences, workspace selection, service-owned settings,
  sync activity and CSV imports into focused windows. Reuse the existing account,
  market-data, model and scheduling forms; keep investment reports together.
- Add an explicit desktop presentation contract and routes. Browser navigation,
  appearance and settings remain unchanged; older services stay compatible.
- Show per-scope update failures in desktop activity even when lightweight
  balance refreshes succeed. Keep task details, recovery controls and diagnostics
  available without filling the investment window with service management.

### Fixed

- Preserve unsaved service forms on repeated window opens, close service windows
  on source changes, and keep all external WebViews outside native capabilities.
- Persist only the chosen startup flag when changing App preferences and retain
  saved HTTPS connections while opening temporary synthetic demonstrations.
- Keep a new local workspace's pending first sync neutral in the desktop sidebar,
  and explain that synthetic demonstrations do not run update tasks.
- Return the workspace picker to its list after a successful connection and clear
  obsolete form errors when retrying a workspace action.

### Notes

- This version continues the internal Apple Silicon desktop preview. Public
  signing, notarization, binary auto-updates and background collection are not
  introduced. Desktop presentation on a remote service requires this web version;
  an older service continues to render its existing browser presentation.

## [1.9.15] - 2026-10-04

### Fixed

- Share identical nonempty dependency files below 4 KiB and immutable static web
  assets across retained macOS releases. Verify independent pool copies before
  atomic replacement; preserve executable modes, rollback links, mutable server
  pages, bytecode and application state.

## [1.9.14] - 2026-10-04

### Fixed

- Share identical historical chunks with independently stored recovery packs,
  retaining every original manifest, date and byte. Gate activation on a fresh
  verified backup and all retained readers; compact redundant containers with
  durable locator transactions, readback checks and interruption recovery.
- Group sealed-recovery reads by physical container to avoid repeated
  decompression, without skipping full restore or checksum verification. Keep
  new already-compressed recovery packs available for subsequent shared reads.
- Bound the disposable public filing cache to 64 MB in daily maintenance;
  retain recent cache entries and all original financial records.

## [1.9.13] - 2026-10-03

### Fixed

- Gate lossless sealed-recovery compression on the current and two rollback
  readers. Migrate raw copies in bounded, resumable, verified batches while
  preserving original manifests, dates and bytes; stream large files separately.
  New daily captures reuse compressed objects instead of recreating raw copies.
- Resume unfinished bounded maintenance on the next scheduled check without
  taking another backup. Bind verification proofs to relevant compressed blob
  locations so unrelated manifest catalog appends do not repeat a full scan.
- Include installed Pi dependencies in the existing verified read-only runtime
  pool so retained releases share identical packages without sharing credentials
  or application state.

## [1.9.12] - 2026-10-03

### Fixed

- Reuse an independent recovery verification within one background run only
  while the manifest, file identities and compressed locators remain unchanged.
  Keep explicit verification and restore exhaustive, discard proofs on restart,
  and scan nightly retention reachability once under uninterrupted locks.
- Report current maintenance progress and elapsed time, and resume interrupted
  maintenance without producing another full recovery point. Retention and
  packing use the same verified repository session.

## [1.9.11] - 2026-10-03

### Fixed

- Read API snapshot indexes without expanding every unrelated artifact after
  each publication. Manifest identity remains checked, and payload reads still
  validate their original content, keeping health checks and history selection
  independent of full historical envelope reconstruction.
- Prepare sealed recovery readers to restore original bytes from the existing
  compressed blob and pack pools, with declared-size limits, corruption checks,
  and an independent compatibility probe. Compression remains inactive until
  current and retained rollback recovery tools have passed the rollout gate.

## [1.9.10] - 2026-10-02

### Fixed

- Let daily lossless packing catch up with loose history instead of stopping at
  4,096 files. Bound each live/recovery batch to 65,536 files, 2 GiB and 120
  seconds, yield to deployment requests between complete durable packs, and
  report time and remaining work. Preserve original bytes, independent recovery
  verification and compatibility with retained rollback readers.

### Security

- Pin the upstream braces nesting-depth fix for GHSA-vfj7-8cjw-p6xm in the
  development-only Next.js lint dependency. Validate the patch with malicious
  input and directory-matching regression tests. Keep audit findings visible;
  scope temporary handling to the exact patched source and advisory until
  2026-11-03, while all other high/critical findings continue to block release.

## [1.9.9] - 2026-10-01

### Fixed

- Clear small orphan backup files in bounded, durably journaled batches instead
  of allowing only 64 candidates per night. Keep the 2 GB cap, limit removal to
  60 seconds between batches, yield to deployment requests, and report remaining
  work. Preserve independent recovery verification, current reference checks,
  the 24-hour grace period and all unique-history/rollback protections.

## [1.9.8] - 2026-10-01

### Fixed

- Import operator-created offline emergency checkpoints into the shared recovery
  object store without changing their original date, files or snapshot view.
  Retire the full source copy only after independently restoring and validating
  every file, database and historical reference; preserve a durable receipt and
  resume interrupted imports or removals without discarding the recovery point.

## [1.9.7] - 2026-09-30

### Fixed

- Check shared history and JSON chunk paths once per bounded, immutable recovery
  scan instead of repeating filesystem checks for every retained descriptor.
  Preserve all checksum, descriptor and dependency validation.
- Report progress and honor deployment yields during descriptor-reference
  validation; discard scan caches before the next verification or restore.

### Security

- Update Next.js and its ESLint configuration to 16.3.6 for
  [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j).

## [1.9.6] - 2026-09-30

### Fixed

- Keep managed backup history in its existing sealed/chunked representation
  instead of repeatedly expanding and re-encoding every historical JSON value.
  Preserve independent copies, SQLite WAL contents, pinned snapshot pointers,
  full physical checksums and reference validation before publishing recovery.
- Persist incremental archival progress across interruptions. Retain queued
  checkpoints and the last successful recovery point; report backup success,
  pending work and optional maintenance errors separately.
- Capture a short independent pre-migration checkpoint during deployment, then
  let launchd archive and verify it after the new service passes health checks.
  Retry pending work every 15 minutes and yield background work to deployments.

### Security

- Update urllib3 to 2.8.0 for the HTTPS proxy TLS and streaming-response fixes
  reported by the release dependency audit.

### Notes

- Existing archives and logical repository backups remain readable. Sealed
  recovery points require the new backup tool to restore; the restored physical
  state remains readable by runtimes supporting the existing object-pack format.
- Recovery is local; an independent off-host copy is still required for host or
  disk loss. No credentials, financial observations or historical recovery points
  are removed by this maintenance release.

## [1.9.5] - 2026-09-30

### Fixed

- Accept broker display-name revisions for the same identified transaction when
  merging official exports. Keep strict checks for all other transaction fields
  and preserve original source reports.
- Keep ledger reconciliation pending against the last verified cash-flow state
  when research has already refreshed the account summary, so failed account
  updates can recover automatically.
- Distinguish recorded valuations awaiting cash-flow reconciliation from missing
  observations. Keep those records inspectable without inventing P&L values.

### Security

- Update transitive brace-expansion development dependencies to patched versions
  while preserving their existing major versions.

## [1.9.4] - 2026-09-24

### Fixed

- Reuse the deployed Node 22 runtime for unattended Mac mini upgrades when no
  explicit override is set, so a host-level Node upgrade cannot break builds.
- Protect existing local desktop workspaces before a newer App opens them with
  a verified, deduplicated recovery copy. Commit the workspace version only
  after startup checks pass; recover failed or interrupted startup transactions
  without replacing the runtime lock or overwriting credentials.
- Preserve failed-start data separately during recovery, resume interrupted
  restores on next open, and leave post-startup financial records intact after
  ordinary runtime failures. Reopening the same version needs no new backup.

### Notes

- Desktop navigation and settings remain unchanged. Public installers and
  automatic signed binary updates remain deferred.

## [1.9.3] - 2026-09-23

### Fixed

- Accept official cash-only Trading 212 history exports without inventing
  securities fields. Merge overlapping narrow and full reports while preserving
  strict checks for conflicting transactions and incomplete trade schemas.
- Stop retrying deterministic CSV validation and authentication failures. Keep
  broker authentication, permissions, rate limits and outages distinguishable
  in connection settings without returning provider response bodies.
- Sync and compute only the explicitly connected Invest and/or ISA accounts.
  Freeze that selection for each refresh, including refreshes from saved data,
  and preserve absent accounts as unknown in intraday history and charts.
- Show first-sync progress and recovery on an empty local workspace instead of
  implying the service is stopped or an earlier snapshot exists. Disable the
  general update action while a job is already queued or running.
- Reveal reused desktop WebViews before navigating to a workspace so WKWebView
  can paint the new page immediately after a connection switch. Create the
  native settings window visibly and retain it during workspace handoff. Keep
  workspace updates active across window switches and content readable when
  an inactive WebView pauses entrance animations.
- Replace the bundled Node executable atomically when rebuilding the desktop
  payload, avoiding stale macOS executable-signature caches during validation.
- Back up stopped WAL databases on bundled SQLite by permitting sidecar
  initialization with SQL writes disabled; close both backup handles explicitly
  and retain committed rows from active WAL files.

## [1.9.2] - 2026-09-23

### Fixed

- Avoid repeatedly decoding entire cold storage blocks during backup verification
  by reusing verified, individually compressed records in a bounded temporary
  memory cache. Keep full file, database and snapshot recovery checks.
- Report backup capture, verification, publication and maintenance progress as
  it happens, including during deployment. Stop at a safe checkpoint when the
  configurable backup time budget is exceeded instead of waiting indefinitely.

## [1.9.1] - 2026-09-23

### Fixed

- Resolve SMGB and other VanEck UCITS funds through official full holdings.
  Add State Street/SPDR, Amundi, Xtrackers and JPMorgan adapters, and discover
  additional iShares/Vanguard funds through their official catalogues.
- Preserve broker ISINs through constituent discovery, validate downloaded
  identities and dates, and keep unsupported or synthetic substitute baskets
  unexpanded. Retain signed cash/derivatives and expose missing issuer weights.
- Read Invesco's actual fund holdings for the held share class instead of index
  constituents. Isolate issuer failures so other portfolio exposures remain
  available, with stale-cache recovery and bounded retry backoff.
- Document issuer coverage and limits, and show readable source status and
  issuer information in the holdings view.

## [1.9.0] - 2026-09-23

### Added

- Add an internal Apple Silicon desktop preview that bundles the existing web
  app, API, Node and Python runtimes. Create or reopen an independent local
  workspace, connect to an existing HTTPS service, or explicitly try synthetic
  demo data without replacing the saved service connection.
- Guide an empty local workspace through account connection, first-sync progress
  and explicit balance confirmation. Keep credentials in its own Keychain
  namespace and require a successful account refresh before accepting setup.
- Add bounded remote reconnects, local service liveness checks, one-click workspace
  recovery, data-folder access and manual official-version checks. Keep native
  controls separate from portfolio pages, with no native permissions for remote
  content and cleanup limited to the App's owned processes.

### Changed

- Make desktop onboarding the documented user-facing entry and archive the former
  agent/source onboarding material while retaining existing installation scripts.
- Show first-sync guidance for healthy empty local workspaces, while continuing to
  surface failed jobs, unhealthy workers and unexpected snapshot errors.

### Fixed

- Preserve onboarding progress across Settings navigation and saved remote
  preferences across local/demo sessions.
- Keep recovery controls visible after a failed portfolio WebView and reopen the
  original local workspace without resetting records or connections.

### Notes

- The desktop build remains an internal preview. This source release does not
  publish a Developer ID signed/notarized installer or enable automatic updates.
  Real-account first-sync acceptance, signed updates and cross-version recovery
  remain prerequisites for public desktop distribution.

## [1.8.0] - 2026-09-22

### Changed

- Offer ChatGPT/Codex sign-in through Pi’s device-code OAuth, with native credential
  storage, serialized refresh, cancellation, and a separate OpenAI API-key option.
- Refresh fast model recommendations to GPT-5.6 Luna, Claude Haiku 4.5, and
  Gemini 3.8 Flash, keeping existing explicit model selections compatible.
- Consolidate model requests on the pinned Pi AI SDK while retaining the existing
  research workflows and output validation. No agent runtime is introduced.
- Default model assignments to OpenAI and offer a first-connection provider picker
  for OpenAI, Anthropic and Google. Retire legacy DeepSeek/OpenCode defaults without
  deleting their credentials or historical results. Requests never switch to an
  unselected provider when the selected credential is unavailable.
- Require Node.js 22.19 or newer and install the locked model transport alongside
  local setup and Mac mini release builds.
- Keep model use focused on security name resolution. Disable legacy automatic
  portfolio/ticker synthesis and taxonomy by default, including previously queued
  analysis runs, without disabling account or market-data refresh.
- Display overview chart footer P&L as a percentage of opening account value,
  using the same cash-flow-adjusted period calculation as the performance chart.

### Fixed

- Preserve system instructions and declared tools when using Pi's Codex transport,
  and omit the unsupported temperature parameter. Verify real Luna replies and
  schema-validated bilingual analysis before release.
- Restore prior model connection metadata and routing when a macOS upgrade rolls
  back, while retaining newer account records, jobs, broker settings and credentials.

## [1.7.4] - 2026-09-21

### Fixed

- Space 1D and 5D timeline labels according to the chart width and the plotted
  trading-time positions, with room for the latest timestamp. The 5D axis now
  shows a compact date including its year and a separate time in the selected
  display zone. Overview and performance share the same tick selection;
  historical observations, sampling, financial values and longer ranges are unchanged.

## [1.7.3] - 2026-09-21

### Changed

- Move shared portfolio history selection, P&L calculations, display sampling and chart/detail preparation into a framework-independent frontend library with colocated tests.
- Give finite-number parsing and NAV helpers explicit shared owners, updating consumers instead of retaining legacy re-exports.
- Check transitive runtime dependencies so the shared calculation path cannot acquire workspace components or framework adapters.

## [1.7.2] - 2026-09-21

### Changed

- Separate shared NAV, broker-overlay and research projections from dashboard orchestration, with one numeric/CSV decoding module and explicit imports for dashboard, history and research readers.
- Preserve existing financial calculations, provenance, typed responses and cache formats while making the API projection boundary independently testable.

## [1.7.1] - 2026-09-21

### Changed

- Align storage, recovery and architecture documentation with the shipped chunked storage, object packs and on-demand history path. Distinguish fresh defaults from explicit operator activation.
- Add a repository ownership map, generated-file guidance and links from the README and documentation index to current maintenance procedures.
- Preserve the earlier space/time decision as a decision record with an implementation map, removing obsolete pending-rollout claims.

## [1.7.0] - 2026-09-21

### Added

- Load portfolio curves through a snapshot-pinned history endpoint, with a bounded SQLite observation index and exact records fetched only when their table is opened or paged. Reuse immutable observations across cached revisions and exclude only this rebuildable index from backups.

### Changed

- Calculate period P&L and drawdown from all eligible observations on the server before reducing chart transport to the existing display cadence. Preserve original values, source transitions, cash-flow cutoffs, gap connectors and calendar positions across every range and account scope.
- Overview and performance summary requests no longer load the complete intraday artifact. Keep existing full lens responses and raw artifact downloads compatible; cache eviction or failure never changes the underlying financial records.

## [1.6.7] - 2026-09-21

### Fixed

- Keep unchanged logical backup entries reusable when unrelated sealed records are added or the locator index is rebuilt. Bind source identity to the artifact and its exact physical dependencies, so changed record locators or corrupted chunks still invalidate capture and stop publication.

## [1.6.6] - 2026-09-21

### Fixed

- Read an artifact’s sealed chunks in physical block groups before restoring logical order, reducing repeated decompression during backup and history reads. Check the total selected byte budget before loading blocks, retain bounded verified caches, and preserve full original-envelope validation and corruption detection.

## [1.6.5] - 2026-09-21

### Fixed

- Reuse verified source chunks during logical backup capture as well as verification. Keep caches bounded and separate for each operation and storage location, avoiding repeated reads of shared live history without changing independent recovery checks.

## [1.6.4] - 2026-09-21

### Fixed

- Reuse verified logical chunks while checking or restoring packed backups, avoiding repeated decompression of shared history blocks. Keep operation-local memory bounds, source-change detection and complete original-file checksum verification.

## [1.6.3] - 2026-09-21

### Fixed
- Classify the interactive storage working set from published outputs and their physical blocks without re-reading the entire historical provenance graph for every maintenance batch. Preserve all source ancestry in immutable cold storage.

## [1.6.2] - 2026-09-21

### Changed
- Share checksum-verified, read-only installed dependency files across retained macOS releases, independently of external package caches and all business data.
- Keep independent files when hard links are unavailable; reclaim only verified, unreferenced dependency blobs after the existing cleanup grace period.
- Detect content changes while allowing bounded retirement of multiple immutable runtime aliases.
- Route manual tar exports of packed state through a verified independent logical recovery, avoiding mutable index copies during concurrent maintenance.
- Keep original artifact downloads and reads available when background packing retires a loose alias between file inspection and opening; never hide corruption with a fallback.

## [1.6.1] - 2026-09-21

### Changed
- Add bounded, journaled object packing with interrupted-operation recovery and byte-exact validation before retiring loose aliases.
- Gate activation on a fresh independent backup and the active plus two retained rollback readers; leave existing installations opt-in.
- After activation, publish compact incremental recovery catalogs and run bounded nightly packing. Keep frequently accessed records in smaller blocks and sealed history in larger blocks.

## [1.6.0] - 2026-09-21

### Added
- Read self-describing immutable compressed object packs through a rebuildable SQLite location index while preserving original artifact identities and downloads.
- Read compact recovery manifests that reuse immutable file entries and preserve every historical manifest byte without depending on a parent backup.

### Changed
- Prepare a reader-first storage rollout: existing writers and loose files remain supported; conversion is not enabled by installing this release.
- Normalize backups of packed artifacts to independent original envelopes, with corruption checks and original-state restore support.

## [1.5.14] - 2026-09-20

### Fixed

- Allow a verified cleanup batch to retire multiple releases sharing an immutable Node executable. Validate its contents instead of treating another alias being removed as unexpected file modification.

## [1.5.13] - 2026-09-20

### Fixed

- Preserve recovery points that are the last copy of immutable artifacts, published snapshots, import sources or legacy broker records, even when ordinary date-based retention would retire them.

## [1.5.12] - 2026-09-20

### Fixed

- Reduce duplicate physical reads within each backup verification using a bounded, operation-local cache; every verification still re-reads physical chunks and validates full original file checksums.
- Share checksum-verified immutable Node executables across retained macOS releases, and retire aged toolchain objects only after their final runtime link disappears.

## [1.5.11] - 2026-09-20

### Fixed

- Reduce small-file allocation in shared JSON storage with coarser lossless blocks while preserving compatibility with existing descriptors and retained readers.

## [1.5.10] - 2026-09-20

### Fixed

- Reuse one lossless artifact representation across legacy and compact managed backups, avoiding duplicate live chunk copies in daily recovery storage.
- Check source chunk changes before reusing logical backup entries, and inspect each recovery digest once during retention planning.

## [1.5.9] - 2026-09-20

### Fixed

- Account for the complete macOS installation with file and allocated-byte
  totals, a configurable 5 GB budget, bounded daily growth history and capacity
  thresholds visible in operator diagnostics.
- Retire old unprotected runtimes during verified nightly backup maintenance,
  keeping current and both rollback runtimes, age gates and bounded removals.
- Bound retrievable filing caches and omit them from new recovery copies while
  preserving original broker observations, price history and old backup contracts.

## [1.5.8] - 2026-09-20

### Fixed

- Compact existing state and recovery blobs in bounded, resumable batches with
  byte-exact checks, prepared journals and rollback-reader compatibility gates.
  Retain original recovery dates, manifests, observations and artifact IDs.
- Group medium research arrays before storage to avoid excessive small-file
  allocation, and sync physical block and index directory entries on publication.
- Restore the original representation when post-write verification fails;
  preserve valid recovery blobs until their independent replacement is verified.

## [1.5.7] - 2026-09-20

### Fixed

- Add bounded, lossless readers for compressed artifacts, shared research JSON
  subtrees and filing caches. Keep legacy writes as default until the active
  runtime and both protected rollback releases support recovery of the format.
- Include shared physical dependencies in backup verification and restored
  snapshot validation without changing logical artifact identities or downloads.
- Retain only verified standalone web output and production Python dependencies
  in newly built macOS releases; reject incomplete or externally linked runtimes
  before removing build dependencies or switching the active deployment.

## [1.5.6] - 2026-09-20

### Fixed

- Supply known response lengths to streaming Brotli so large chart histories
  retain whole-response compression efficiency without buffering their bodies.
  Preserve unknown-length streams, gzip/identity clients and cancellation.

## [1.5.5] - 2026-09-20

### Fixed

- Negotiate streaming Brotli for private dashboard responses while preserving
  gzip and uncompressed clients, cancellation, error propagation and no-store
  semantics. Reduce transfer bytes without changing the financial payload.
- Read lossless, date-chunked history with separately retained provenance;
  preserve logical artifact IDs, downloads and verified backup restores. Keep
  legacy writes as the default and provide byte-checked shadow writes before
  the separately gated production storage transition.
- Import dated legacy archives into independent deduplicated recovery storage,
  preserving their original recovery date and exact database/file bytes. Reject
  unsafe or oversized archives and leave source archives intact.

## [1.5.4] - 2026-09-19

### Fixed

- Keep unused seasonality matrices out of the overview and unused intraday
  histories out of account-review downloads. Scope chart-history requests by
  account and date range while preserving source transitions, raw extrema,
  complete daily risk history and cash-flow reconciliation boundaries.
- Deduplicate macOS recovery copies into independent compressed file blobs,
  verify database and snapshot integrity before publication, and complete the
  backup before stopping the current application during deployment.
- Add separate, bounded retention planning with protected current/rollback
  runtimes, backup reference checks, stale-plan rejection and deletion journals.
  Keep legacy archives restorable and live account/artifact state untouched.

## [1.5.3] - 2026-09-19

### Fixed

- Treat Trading 212 transaction totals as fee-inclusive settlement cash in
  campaigns, diluted cost and capital recovery. Keep fees as a separate
  breakdown without deducting them again from net cash or closed-campaign P&L.
- Preserve independently known net amounts when fee-conversion evidence is
  missing, and invalidate the affected derived account artifacts.

## [1.5.2] - 2026-09-19

### Fixed

- Normalize foreign-settled transaction and CFD amounts into GBP with dated FX
  evidence. Preserve unavailable values through API, review and household
  projections when a reliable conversion is missing.
- Allocate CFD financing and dividend events once across partial closes, retain
  unassigned costs explicitly, and reconcile attribution to realised totals.
  Keep missing net amounts unavailable when the source omits the fee evidence
  needed to derive them.
- Count cash-flow verification from retained current-snapshot observations,
  independently of historical refresh-job counts.
- Backfill missed account-history dates from available market data, preserve
  identified broker observations, and retain reconciled cash flows when a
  same-day valuation is refreshed. Keep weekend observations on their actual
  dates and assign later cash movements to their actual valuation interval.
  Suppress returns and P&L across uncertain observation timing instead of
  recreating them in dashboard or review projections.
- Measure downside deviation against the return target so repeated equal
  losses do not incorrectly produce an unavailable Sortino ratio.
- Recover cancelled jobs after their worker lease expires, and keep scheduling
  services available when a fresh installation has no published snapshot yet.
- Diagnose bootstrap token mismatches, state-root isolation, source provenance
  and supported Node versions without claiming to have tested live providers.
  Keep schema inspection read-only and report its limits explicitly.
- Supervise all foreground processes and descendants, support linked Git
  worktrees in local service installation, and retain the selected Node path
  for launchd. Deployment readiness now requires a ready JSON result.
- Handle invalid watchlist/job requests, missing analysis resources and
  credential-store failures with controlled errors. Preserve exchange-qualified
  selections and refresh date-sensitive research and alert caches.
- Validate artifact provenance for binary reads and recover interrupted artifact
  metadata writes without changing stored content identities.
- Remove invalidated preview outputs before retries so a failed provider stage
  cannot republish stale results from an earlier checkpoint.
- Match semiannual financial comparisons to the same fiscal half, preserve
  period evidence in valuations, and keep missing filing facts unavailable.
- Use one common 20-session volume window and avoid options signals without
  usable open-interest or gamma evidence. Invalidate affected research caches.
- Validate security identifiers before replacing the durable catalog, reject
  non-finite CFD inputs and conflicting close adjustments, and normalize strict
  structured-output request schemas.

### Security

- Preserve credential isolation for custom installations, remove a secret-bearing
  command-line fallback, and redact validation failures on model-provider routes.
- Exclude environment-file variants from both backup paths, create private
  archives, and reject unsafe backup destinations and retention settings.

### Changed

- Remove unreachable legacy frontend modules and migrate relevant regression
  coverage to the active workspace code.
- Refresh the onboarding skill, installation and diagnostic runbooks, provider
  notices and metric documentation against the current application behavior.
- Update README product screenshots from an isolated simulated broker portfolio
  using current provider data and the current portfolio P&L presentation.
- Align the example intraday retention with the 210-day default, and strengthen
  release gates for deployment checks and validated release tags.

## [1.5.1] - 2026-09-19

### Fixed

- Distribute compact portfolio-chart date labels evenly across the full timeline
  instead of sampling the already-reduced desktop labels a second time. Preserve
  the first and last date, year labels and aligned ticks across linked panels.

## [1.5.0] - 2026-09-18

### Added

- Select allocation-ring slices or category names to keep category, GBP value
  and percentage visible. Inspect grouped categories and use keyboard or touch
  selection across country, industry and GICS views.
- Extend the default intraday retention to 210 days for six-month history;
  reconstruct from available historical market bars while preserving original
  broker observations and genuine daily-only history.

### Changed

- Show cash-flow-adjusted period net P&L on the overview, sharing the detailed
  performance view's accounting basis and verified cutoff.
- Use fixed display intervals of 10 minutes, 30 minutes, one hour, two hours
  and four hours for 1D, 5D, 1M, 3M and 6M. YTD follows its elapsed span; 1Y
  and All display daily observations without reducing calculation precision.
- Give P&L and drawdown charts more height and eight date ticks on wide panels,
  with adaptive spacing on smaller screens.
- Show complete, wrapping allocation names alongside values; all allocation
  bar backgrounds represent 100%, including the largest category.

### Fixed

- Draw dashed connectors only across empty display buckets instead of every
  missed collection slot. Keep original gaps, source metadata and financial
  calculations intact without inventing observations.
- Keep chart fills visually continuous across gaps while suppressing readings
  on connector and fill layers; preserve exact records below the chart.

## [1.4.8] - 2026-09-18

### Fixed

- Keep date and year on separate lines in portfolio history axes so labels fit
  narrow overview cards and mobile screens. Preserve intraday clock labels,
  full timestamps in tooltips, and the shared overview/performance timeline.

## [1.4.7] - 2026-09-18

### Fixed

- Make the overview value chart a compact version of the performance value
  layer, using the same verified accounting cutoff, sampled observations,
  contribution steps, gap connections, tooltips, and exact-record display.
- Preserve account and period when opening performance from the overview;
  keep range choices in the URL across reloads and browser navigation.
- Keep value change distinct from cash-flow-adjusted profit/loss. Show the
  cumulative-contribution baseline at short and long ranges alike.
- Replace the dense coverage strip with a shared, expandable missing-record
  explanation while keeping pending cash-flow cutoffs visible.

## [1.4.6] - 2026-09-18

### Fixed

- Offer optional Alpaca historical SIP and BOATS prices to reduce stale US
  overnight marks during account reconstruction. Yahoo remains the default
  and fallback, including foreign securities and currency conversion.
- Add test-before-save Alpaca settings, reversible enhancement controls, and
  operating-system credential storage without returning keys to the browser.
- Respect delayed-data access, pagination, nominal prices, completed bars,
  exchange holidays and daylight saving. Bound overnight quote carry to ten
  minutes, retain real gaps, and preserve original broker observations.
- Record reconstruction feed coverage and fallback reasons in immutable
  provenance artifacts; reuse incremental caches outside the checkout.

## [1.4.5] - 2026-09-18

### Fixed

- Apply quote freshness from the actual market open, including pre/post-market
  sessions, without giving hourly prices an extra opening-hour grace period.
- Choose the newest completed observation across minute and hourly feeds before
  checking freshness. Keep the existing hourly fallback budget without reverting
  to an older price, and normalize pence consistently for hourly-only history.
- Carry closed-market prices only when the latest completed trading session has
  adequate quote coverage. Replace obsolete model results on a complete replay
  while retaining original broker observations and immutable source artifacts.

## [1.4.4] - 2026-09-17

### Fixed

- Draw missing portfolio observations as dashed endpoint connections without
  estimated values, filled areas or disconnected point markers. Keep hover
  readings tied to recorded observations in overview and performance charts.
- Advance reconciled cash-flow evidence with each live price update when ledger,
  cash and verified position quantities are unchanged. Preserve the last verified
  accounting cutoff when an actual account change needs reconciliation.
- Align value, contributions, profit/loss, drawdown and headline metrics to one
  cutoff; retain orange contribution steps and cash-flow changes at every range.

## [1.4.3] - 2026-09-17

### Fixed

- Stop inserting reconstructed valuations into missed broker collection slots
  after live history begins, preventing artificial spikes in account value,
  period profit/loss and drawdown. Retain earlier reconstructed history and all
  original broker and model evidence without adjusting their values.
- Connect real observations across collection gaps of at most 30 minutes without
  inventing intermediate samples. Preserve longer outages, unknown cash-flow
  values and accurate coverage records in both overview and performance charts.

## [1.4.2] - 2026-09-16

### Fixed

- Keep scheduled live account collection when a half-hour performance task
  reaches the queue first; retry a busy current slot without replaying old slots.
- Read only active jobs and the relevant schedule records for admission and
  status, avoiding repeated loading of thousands of completed jobs.
- Reuse schedule reads for legacy and current refresh-state fields and keep the
  reported next attempt aligned with deferred collection.

## [1.4.1] - 2026-09-16

### Changed
- Rebuild the README around the current portfolio and research workspace, with reviewed broker-only demonstration screenshots and direct installation and guide links.
- Add a documentation index and practical portfolio, research, valuation, options, and data-convention guides.
- Align architecture, privacy, and recovery documentation with unified cash-flow-aware P&L, independent research lenses, source coverage, and retained macOS releases.
- Replace internal iteration names and obsolete interface screenshots with documentation for the shipped 1.x product.

## [1.4.0] - 2026-09-16

### Added

- Extend technical readings with trend, volatility, volume and price-position measures, and add comparable basic/diluted weighted share counts.
- Save model rationale with assumptions and show the source of default scenarios while preserving older model versions.
- Link broker cash-flow evidence to intraday NAV and unify portfolio value, net flows and profit/loss across time ranges.
- Provide closed broker-trade fixtures for preview attribution without mocking market, FX or research data.

### Fixed

- Keep missing cash-flow evidence distinct from zero and align portfolio headlines with the calculations shown in charts and records.

## [1.3.9] - 2026-09-16

### Fixed

- Build macOS upgrades in independent release directories while the active app remains available.
- Retain complete installed runtimes and restore them on cutover failures without rebuilding or downloading dependencies.
- Preserve credentials during deployment, verify a consistent state backup, and cover additional dynamic routes in the production smoke check.
- Record interrupted deployments for explicit recovery and serialize host upgrades with a process lock.
- Retain the supported Node 22 executable per release, isolate Python build environments, and expand service paths safely.

## [1.3.8] - 2026-09-16

### Fixed

- Include years on multi-year timelines and keep intraday labels in the exchange timezone.
- Use consistent dates in axis labels and chart readings while keeping single-session axes compact.
- Dismiss chart readouts before their enclosing dialog and give help dialogs an explicit keyboard focus target.

## [1.3.7] - 2026-09-16

### Fixed

- Stabilize scenario comparisons against the current price and preserve their actual relative distances.
- Edit assumptions in percentage units, preserve intermediate input safely, and compare changes using the same horizon.
- Keep model saves tied to the submitted inputs and prevent stale previews from being saved during recalculation.

## [1.3.6] - 2026-09-16

### Fixed

- Keep overview focused on a three-month price line, with company logos and research-list pinning in context.
- Separate price charts, technical readings and seasonality into navigable sections.
- Keep advanced chart controls in the full chart and enforce valid interval/range combinations.

## [1.3.5] - 2026-09-16

### Fixed

- Format chart percentages and large amounts consistently, including accessible chart readings.
- Show annual dividends as a line and distinguish incomplete years from full-year totals.
- Improve business-segment comparisons and financial-history scales without hiding missing observations.

## [1.3.4] - 2026-09-16

### Fixed

- Reuse research and price requests across views, cancel obsolete navigation requests, and retain only matching security data during refresh.
- Cache immutable research evidence by revision and serve compact overview and document responses without unrelated calculations.
- Limit overview prices to their visible three-month window and expose actual history coverage and server timing.

## [1.3.3] - 2026-09-16

### Fixed

- Correct historical market sessions and technical calculations across exchange holidays and partial trading days.
- Preserve filing evidence and use split-consistent real price histories for research calculations.

## [1.3.2] - 2026-09-16

### Fixed

- Coalesce identical in-flight research and artifact reads without serializing
  unrelated securities behind a network lock. Bound cached entries and avoid
  retaining failed requests as successful results.
- Revalidate immutable artifact and snapshot files when their file metadata
  changes so a previous successful read cannot hide a replaced or corrupt file.

## [1.3.1] - 2026-09-16

### Fixed

- Match company names, tickers, and spelling variants against verified security
  identities. Rank exact and relevant matches ahead of unrelated fuzzy results,
  and show up to three meaningful candidates in the add-security dialog.
- Keep an existing company-name index usable during provider outages, refresh
  it using the correct clock, and bound identity lookups and cache lifetimes.
- Keep displayed search results aligned with the current submitted input;
  cancel obsolete requests and allow an explicit retry of the same search.

## [1.3.0] - 2026-09-16

### Added

- Add financial facts with annual, quarterly, and trailing periods, business
  and geographic segments, filing references, and comparability checks.
- Add independent research workflows for forecasts, analyst evidence, company
  events, options structure, fund exposure, valuation, and research notes.
- Add saved valuation models with source assumptions and financial context,
  plus research comparisons and evidence-linked financial views.
- Add price history and events, seasonality sample selection, exchange-aware
  calendars, and corporate-action context.

### Fixed

- Keep missing evidence and incomplete history visible rather than replacing
  them with fabricated figures, and show the selected seasonality sample.
- Preserve the previous release's security, reference-data packaging, and
  authoritative-classification fixes throughout the research expansion.

## [1.2.0] - 2026-09-16

### Added

- Rebuild the portfolio workspace with account summaries, holdings and ETF
  look-through, performance comparisons, account journals, and independent
  security research views.
- Reconstruct portfolio value on a ten-minute intraday timeline, including
  available extended-hours prices, and preserve collected broker observations.
- Add an isolated broker preview that uses synthetic Trading 212 inputs with
  real market, FX, benchmark, and research providers.
- Expand official Vanguard and iShares holdings adapters while preserving
  bonds, cash, derivatives, and issuer exposure.

### Changed

- Introduce a consistent blue visual identity, light and dark themes,
  bilingual navigation, responsive layouts, and keyboard support.
- Organize research by financial meaning, reduce repeated explanatory copy,
  and keep metric definitions and provenance available in context.
- Display 1D, 5D, 1M, and 3M charts at fixed ten-minute, thirty-minute,
  hourly, and two-hour intervals while retaining ten-minute source records.

### Fixed

- Include reference data once in backend wheels and source distributions so
  rebuilding an installation archive succeeds with current build tooling.
- Preserve official and manually reviewed industry classifications when an
  expired company profile is refreshed from a public market-data provider.
- Keep performance hover cards stable and theme-aware; join compatible broker
  and reconstructed observations without hiding genuine missing-data gaps.
- Preserve exchange-qualified securities, quote and statement currencies,
  financial units, and missing values across research and account views.
- Correct holdings sorting, analyst rating bands, period alignment, account
  history coverage, review units, and classification enrichment.
- Preserve newer settings drafts during saves, report validation failures,
  and restore focus after closing nested overlays.

### Security

- Update Next.js, image-processing and YAML dependencies to patched releases,
  and update the test runner to a supported patched release. Keep the existing
  read-only broker, external-state, and operating-system credential boundaries.

## [1.1.0] - 2026-09-04

### Changed

- Redesign the analyst lens around an interactive five-band recommendation
  consensus, rating trends, recent firm actions, and revenue and EPS forecasts.
- Pair the prior 12 months of actual prices with clearly labelled low, mean,
  and high reference rays for Yahoo's approximately 12-month targets, plus
  target summaries and point-level hover details.

### Fixed

- Remove the repeated research evidence date from the overview signal card;
  the page-level freshness status remains the single source of that context.

## [1.0.8] - 2026-09-04

### Fixed

- Align the overview's account-review and research-signal cards by moving the
  research evidence date into a quiet footer beneath the signal rows.

## [1.0.7] - 2026-09-03

### Fixed

- Prefer the current typed market snapshot throughout the research workbench
  and freshness status, while retaining legacy market data only as a fallback.
- Compare account TWR with auto-adjusted VOO, QQQ, and VT series translated
  into GBP, and calculate VOO benchmark return and information ratio over the
  account's aligned daily valuation intervals.

## [1.0.6] - 2026-09-03

### Added

- Restore optional OpenCode and direct DeepSeek connections in Settings for
  fuzzy security search, automatic classification, and research summaries.

### Changed

- Keep account, market, and deterministic identity sources ahead of model use,
  and fall back to the other configured approved model service before an
  optional research request begins.
- Allow either OpenCode or direct DeepSeek to perform the final bounded entity
  resolution step with one web search, while preserving full operation without
  any model credentials.

## [1.0.5] - 2026-09-02

### Fixed

- Distinguish selected-period and cumulative net P&L in money-chart tooltips,
  keeping range-relative performance intact while making carried CFD results
  visible in the all-account context.

## [1.0.4] - 2026-09-01

### Changed

- Preserve real B, S, and T fill markers for previously held securities while
  they remain in the research watchlist, without adding historical tickers to
  the watchlist automatically.

## [1.0.3] - 2026-09-01

### Added

- Mark real Trading 212 fill days on held-security candlestick charts as B
  (buy only), S (sell only), or T (both directions), with account, order,
  quantity, and weighted-average fill details on hover.

### Fixed

- Keep the research overview candlestick chart fixed to its labelled one-month
  window while reserving draggable history for the dedicated technical view.

## [1.0.2] - 2026-09-01

### Added

- Make the research workbench's technical candlestick chart horizontally
  draggable, so shorter ranges can browse earlier sessions without refetching
  data or driving React updates during the gesture.

## [1.0.1] - 2026-09-01

### Fixed

- Render allocations, weights, shares, rates, volatility, margins, and other
  level percentages without a leading plus sign, while preserving explicit
  positive and negative signs for returns, P&L, drawdowns, growth, and other
  directional changes.

## [1.0.0] - 2026-09-01

### Added

- First public release of the local-first Trading Max portfolio application.
- Added read-only Trading 212 Invest and Stocks ISA ingestion, immutable
  snapshots, cash-flow-aware performance, ETF look-through, Security Master,
  GICS classification, and per-ticker research lenses.
- Added a responsive bilingual Next.js interface backed by FastAPI, durable
  refresh jobs, health/readiness views, backups, and safe restore.
- Added OS credential-store-backed integration settings and an agent-owned
  local onboarding flow that keeps credentials out of chat, files, and logs.
- Added Apache-2.0 licensing, provider attribution, governance, contribution,
  security, privacy, support, and release checks.
- Enforce one SemVer increment and one dated changelog release on every pull
  request, then create an annotated tag and dispatch the complete source
  release pipeline after the protected main-branch CI succeeds.

### Fixed

- Connect internal collection gaps in the overview broker-value chart with
  dashed evidence bridges while keeping leading, trailing, and observed
  intervals visually distinct.
- Resolve historical prices by exact ISIN cross-listing and quote currency,
  preventing sparse broker trade prices from concentrating multi-day returns
  into a false jump on the next trade date.
- Fail historical NAV reconstruction when a held security lacks market prices
  instead of silently carrying a transaction price across unpriced dates.
