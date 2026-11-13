# ETF look-through sources

Trading Max combines broker-held fund units with dated constituent files from
the issuer. The broker's ISIN takes precedence over its trading code. For example,
SMGB and the London SMH listing share ISIN IE00BMC38736; the US fund traded as
SMH is a different instrument.

## Supported discovery and downloads

| Issuer | Discovery and scope | Holdings source |
|---|---|---|
| iShares / BlackRock | UK ETF catalogue, exact ISIN | Official full holdings API |
| Vanguard | UK fund directory, exact ETF share class | Paginated portfolio holdings API |
| VanEck | UK UCITS ETF catalogue; SMGB available directly | Full holdings block with ISIN, FIGI, country and sector where supplied |
| State Street / SPDR | UK UCITS and US ETF catalogues | Official daily holdings workbook linked by the catalogue |
| Invesco | Known fund ISIN and issuer name | Actual fund holdings and allocations, checked against the share-class profile |
| Amundi / Lyxor | Known fund ISIN and issuer name | Full physical-fund composition, including signed cash and derivatives |
| Xtrackers / DWS | Known fund ISIN and issuer name | Full securities-held table after identity and physical-replication checks |
| JPMorgan | Known UCITS ISIN and issuer name | Full daily holdings, not the top-ten preview |
| HSBC Asset Management | Existing HEMC adapter | Official holdings workbook and separately dated sector factsheet |

This is adapter coverage, not a promise that every product worldwide is
available. Country catalogues, fund structures and issuer access restrictions
can limit individual products. WisdomTree, UBS and Fidelity complete-holdings
downloads are not currently verified integrations. Their top-ten factsheets
are not substituted for full portfolios.

## What the source status means

Open **Holdings & exposure → Look-through → Sources** to see the issuer,
portfolio date, reported constituent count and weight total.

- **Verified:** identity, dates and the full reported list passed validation.
  This does not mean the holdings are real time or every company has a GICS
  classification.
- **Some positions have no reported weight:** the issuer supplied a full file
  but omitted weights on some rows. State Street can do this for cash and
  futures. Only numeric reported weights enter the allocation; no weights are
  invented for the remaining rows.
- **Unavailable:** no usable source is present. The fund remains an unresolved
  fund exposure, and the other funds and direct positions remain available.

Signed weights, issuer rounding and separately dated industry data are retained.
A small reconciliation tolerance accommodates rounding; an incomplete list is
never rescaled to 100%. Cash, futures, options and swaps do not become company
equity positions. Synthetic ETF substitute baskets are not presented as the
fund's economic index exposure.

## Cache and recovery

Holdings are refreshed after 18 hours, while product catalogues are cached for
seven days. A failed issuer download retains its last valid snapshot and backs
off for one hour. The displayed portfolio date continues to show the actual
source date. New cache files include the fund ISIN, so a reused ticker cannot
silently inherit a different fund's holdings.

All caches remain in the selected external state directory:

- `raw/fund-holdings/v4/`: normalized constituent snapshots keyed by share-class ISIN, with retry timestamps;
- `reference/fund-catalogs/`: issuer product identities and download links.

Upgrades can read the previous v3 or ticker-only cache but leave those
files untouched. Older releases therefore retain their compatible snapshots
on rollback. The API keeps its existing source-status values; missing weights
are reported through an additive count and warning.

An operator-managed normalized snapshot is still supported. Include `fundIsin`
when the broker supplies an ISIN; a legacy ticker-only file cannot establish a
different or otherwise unknown fund identity. The fund registry describes
download routes and never decides whether a broker instrument is an ETF.

Issuer websites may change their schemas or block requests. Validation fails
explicitly in those cases; a missing download is not permission to substitute a
similar fund, another share class, an index preview or fabricated holdings.

## Tracking and portfolio overlap

The account refresh publishes a compact ETF reading by share-class ISIN. Listing
quotes have their own ticker, market identifier and quote unit. EQQQ
(IE0032077012) and the GBP-hedged EQGB (IE00BYVTMW98) remain distinct. An issuer
may publish valid holdings without sector or country distributions; those
breakdowns remain unavailable. The fund view distinguishes unavailable
holdings, a failed refresh and an old disclosure.

The one-year tracking difference is share-class NAV total return minus the
documented benchmark total return for the same period, currency and hedging
basis. Issuer tracking error is a separate observation. When the issuer's
benchmark and share class have different bases, Trading Max reports them as
incomparable. The research desk displays the original issuer period; values
over 120 days old are marked stale.

| Share class | One-year tracking coverage |
|---|---|
| HSBC MSCI Emerging Markets USD Acc (HEMC, IE000KCS7J59) | Reads the latest rolling 12-month fund and reference benchmark returns from the [monthly factsheet](https://www.assetmanagement.hsbc.co.uk/api/v1/download/document/ie000kcs7j59/gb/en/factsheet) already downloaded for sector weights. The [fund supplement](https://www.assetmanagement.hsbc.lu/api/v1/download/document/ie000kcs7j59/lu/en/supplement) distinguishes the base-currency USD class from the hedged classes. The report identifies the unhedged USD MSCI Emerging Markets Net Total Return benchmark (NDUEEGF). The app subtracts the displayed returns, so the result can differ slightly from HSBC's separately rounded tracking difference. |
| VanEck Semiconductor (SMGB, IE00BMC38736) | Missing. The [UK factsheet](https://www.vaneck.com/uk/en/library/fact-sheets/smh-fact-sheet.pdf) publishes month-end one-year USD NAV and net total return benchmark (MVSMCTR) figures. SMGB trades in GBP but is the same USD share class. The existing overview response has a performance block placeholder, and its holdings response contains no return pair. Fetching the performance block or factsheet would require an additional request, which is not enabled under the terms below. |
| Invesco EQQQ Nasdaq-100 GBP Hdg Acc (EQGB, IE00BYVTMW98) | Incomparable. The [share-class API](https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses/IE00BYVTMW98?idType=isin) lists a single benchmark, the USD NASDAQ-100 Notional Net Total Return Index (NNDX / XNDXNNR). The [factsheet](https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE00BYVTMW98_factsheet_en.pdf) compares it with GBP-hedged NAV. Neither response supplies a GBP-hedged benchmark return. |

Overlap adds the smaller of the two weights for each exact security ID. The
other side includes direct and look-through Invest and ISA positions after
excluding every listing of the fund's share class, cash and CFDs. Unidentified
weights remain in their original denominators. Both coverage readings and all
holdings dates are available with the number. Holdings dates must be within 45
days to qualify for an overview warning.

The overview reads only the compact publication, after the table loads. The
position drawer and fund research use the same observations. The drawer reads
the account snapshot without making issuer requests.

Held funds appear in the research desk automatically. Invest and ISA share a
research entry for the same listing. Listings keep their own price history;
issuer holdings, tracking and overlap are shared by ISIN. A fully sold fund
leaves the held list and stays in research only if it was saved to the watchlist.

Research refreshes reuse the account publication for issuer evidence. The fund
price and technical score use the same daily history, with no additional issuer
calls. Recognized funds skip company earnings, analyst estimates and valuation.
The options dataset can include verified US ETF underlyings, as described below.

## Official source entry points

- [VanEck Semiconductor UCITS ETF](https://www.vaneck.com/uk/en/investments/semiconductor-etf/overview/)
- [State Street fund finder](https://www.ssga.com/uk/en_gb/institutional/fund-finder)
- [iShares products](https://www.ishares.com/uk/individual/en/products/product-list)
- [Vanguard fund directory](https://www.vanguard.co.uk/uk-fund-directory)
- [Amundi product example](https://www.amundietf.com/amundi/lux/en/instit/IE0009BI8Z04)
- [Xtrackers product example](https://etf.dws.com/en-gb/IE00BGV5VN51-artificial-intelligence-big-data-ucits-etf-1c/)
- [JPMorgan product example](https://am.jpmorgan.com/gb/en/asset-management/adv/products/jpm-global-research-enhanced-index-equity-active-ucits-etf-usd-acc-ie00bf4g6y48)

See [security identity and GICS](../architecture/security-master-and-gics.md)
for the constituent-to-company enrichment contract.

## Research depth and data rights

The fund research overview reports exact ISIN matches from HMRC's
[approved offshore reporting funds](https://www.gov.uk/government/publications/approved-offshore-reporting-funds).
It distinguishes approval, a future effective date, cessation, an absent match
and unavailable evidence. The list can omit an ISIN; an absent match is not a
tax classification. The displayed dates come from the register. Contains
public sector information licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
The background refresh checks GOV.UK metadata at most once per week per state
root, downloads the workbook only for a new release, and keeps the last valid
register on failure. Failed attempts back off for one day.

The peers lens compares exact observed benchmark labels, domicile, hedge and
income treatment. It uses held profiles plus existing issuer catalogue entries
with a cached, ISIN-verified share-class profile. A catalogue name alone does
not establish a benchmark. Each percentile uses a separate comparable subset:
same fee basis; same currency and disclosure date for share-class assets; same
one-year period, currency, hedge and net/gross benchmark variant for tracking;
and the same portfolio snapshot with at least 90% coverage on both sides for
overlap. Higher percentiles mean larger raw values. A tied peer counts half
and a single observation has no percentile. Overlap is only available for
held share classes. The UI shows each subset's count and evidence. Coverage
varies with the share classes already observed; there is no network sweep of
issuer catalogues to fill missing peers.

The journal records observed changes to issuer benchmark labels and retains
their sources and observation times. Missing disclosures do not erase the
last known benchmark. A change does not imply a historical rule effective date
unless the issuer evidence supplies one. No history is invented for periods
before the observations began.

Additional data connections remain off pending usable rights and evidence:

| Source | Conclusion for new collection |
|---|---|
| [BlackRock / iShares UK](https://www.ishares.com/uk/individual/en/compliance/terms-and-conditions) | Public NAV and performance disclosure; copying and reuse are restricted. No automated NAV archive or new catalogue requests. |
| [Invesco](https://www.invesco.com/corporate/en/footer/terms-of-use.html) | Personal website use does not establish an automated NAV archive grant. No new requests. |
| [Vanguard UK](https://www.vanguard.co.uk/uk-fund-directory/terms-and-conditions) | Public fund directory and prices; no verified product reuse or systematic archiving grant. No new requests. |
| [VanEck UK](https://www.vaneck.com/uk/en/terms-and-conditions) | Personal storage is allowed; commercial reuse requires prior consent. No verified permission to add performance collection to the product. |
| [HSBC Asset Management UK](https://www.assetmanagement.hsbc.co.uk/en/individual-investor/terms-and-conditions) | Automated extraction and systematic storage require prior written permission. The one-year observation reuses the existing sector factsheet response on the existing refresh schedule. No new request or historical return series is added. |
| [State Street](https://www.ssga.com/dk/en_gb/footer/terms-and-conditions) and other existing issuer adapters | No new data connection or reuse grant assumed. |
| [Yahoo Finance](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) | Some LSE pages expose delayed bid and ask, without verified per-side observation times or permission to automate sampling and archive data. No new quote requests. |
| [MSCI](https://developer.msci.com/apis/index-api), [FTSE Russell](https://www.lseg.com/en/ftse-russell/index-resources/indices-subscribe-data), [S&P DJI](https://www.spglobal.com/spdji/en/disclaimers/) and [Nasdaq](https://www.nasdaq.com/products/global-indexes/data) | No verified free feed for the necessary daily benchmark total-return variants with rights for this use. No new requests. |

Daily NAV history, bid/ask and premium/discount stay unavailable without
authorized sources. A closing market price is not compared with a NAV struck
at an unverified time, and a session high/low is not a spread. Issuer-published
tracking error remains available where reported; the desk does not estimate
daily tracking error from a price-only index, another ETF, or mismatched NAV.
The portfolio overview's compact ETF publication is unchanged.

## US-listed ETF references

Verified against issuer disclosures on 2026-11-13. References are selected by
share-class ISIN. “Same index” requires the same benchmark variant, including
its stated return basis. “Similar” means related exposure with a different
benchmark. US rows do not enter the UCITS comparison or its percentile counts.

| UCITS listing | Issuer benchmark | US reference and issuer benchmark | Relation |
|---|---|---|---|
| EQGB.L (IE00BYVTMW98) | [Nasdaq-100 Notional Net Total Return (XNDXNNR)](https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE00BYVTMW98_factsheet_en.pdf) | [QQQ](https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf), [QQQM](https://www.invesco.com/us-rest/contentdetail?contentId=5b4d8e58e0737710VgnVCM1000006e36b50aRCRD&dnsName=us) · Nasdaq-100 Total Return (XNDX) | Similar: same constituent rules, [different dividend treatment in the index](https://indexes.nasdaq.com/docs/Index_Versions_NDX.pdf). EQGB is GBP hedged; QQQ and QQQM are quoted in USD and have no GBP hedge. |
| XUSE.L (IE000R4ZNTN3) | [MSCI World Ex US Net Index](https://www.ishares.com/uk/individual/en/products/340748/) | [VEA · FTSE Developed All Cap ex US Index](https://advisors.vanguard.com/investments/products/vea/vanguard-ftse-developed-markets-etf) | Similar: VEA adds small caps and includes South Korea under FTSE’s developed-market classification. |
| IUMF.L (IE00BD1F4N50) | [MSCI USA Momentum Factor Net Index](https://www.ishares.com/uk/individual/en/products/285208/ishares-edge-msci-usa-momentum-factor-ucits-etf) | [MTUM · MSCI USA Momentum SR Variant Index](https://www.ishares.com/us/products/251614/ishares-msci-usa-momentum-factor-etf) | Similar: US momentum exposure with different index rules. |
| HEMC.L (IE000KCS7J59) | [MSCI Emerging Markets Net](https://www.assetmanagement.hsbc.co.uk/en/intermediary/funds/ie000kcs7j59) | [EEM · MSCI Emerging Markets Index (Net)](https://www.ishares.com/us/products/239637/ishares-msci-emerging-markets-etf-eem) | Same index: net return benchmark. HEMC is a GBP trading line; EEM is quoted in USD. |
| SMGB.L (IE00BMC38736) | [MarketVector US Listed Semiconductor 10% Capped Screened Index (MVSMCTR)](https://www.vaneck.com/uk/en/investments/semiconductor-etf/overview/) | [SMH · MVIS US Listed Semiconductor 25 Index](https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/) | Similar: the UCITS benchmark has a 10% cap and ESG screens. US SMH and London SMH are distinct listings. |
| SEMI.L (IE000I8KRLL9) | [MSCI ACWI IMI Semiconductors & Semiconductor Equipment ESG Screened Select Capped Index](https://www.ishares.com/uk/professionals/en/products/319084/) | [SOXX · NYSE Semiconductor Index](https://www.ishares.com/us/literature/fact-sheet/soxx-ishares-semiconductor-etf-fund-fact-sheet-en-us.pdf) | Similar: global and ESG screened versus US-listed sector exposure. |

The options lens uses the first US reference (QQQ for EQGB); US ETF pages
display their own chains when captured. Marks and strikes stay in the US
underlying’s USD units. The pipeline fetches the ETF chains in daily
reconciliation (or legacy nightly refresh) and in explicitly requested research
refreshes. The normal intraday research slots carry the most recent chains
forward. No issuer download or options request is triggered by opening a lens.

For the seven reference tickers above, daily reconciliation adds at most one
shared daily quote batch (20 symbols per request, with cache reuse) and seven
option capture attempts. Each attempt uses the existing Yahoo security metadata
and expiry list, then up to four expiries within 120 days. The current
yfinance metadata helper makes up to three logical reads (quote summary,
quote and complementary statistics), so seven chains add at most 56 logical
Yahoo reads, plus the quote batch and the existing shared
Treasury input if it has not already been read that day. HTTP retries and Yahoo
session setup are provider transport overhead. The same US ticker is captured
once per job even when directly held. A reference added only for its options
does not enter technical scoring. A held or separately saved ETF still gets its
own technical score.
