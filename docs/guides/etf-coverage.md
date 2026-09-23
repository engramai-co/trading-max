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

- `raw/fund-holdings/v3/`: normalized constituent snapshots and retry timestamps;
- `reference/fund-catalogs/`: issuer product identities and download links.

Upgrades can read the previous `raw/fund-holdings/*.json` cache but leave those
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
