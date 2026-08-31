# Dynamic Security Master, Entity Resolution and GICS

Trading Max resolves the securities it observes at runtime. There is no
shipped company list, ticker-to-sector map, ETF whitelist or company
classification seed.

Three concepts remain separate throughout the pipeline:

1. **Instrument** — one tradable listing or share class, identified by ISIN,
   FIGI, composite FIGI, share-class FIGI and exchange/MIC-qualified ticker.
2. **Issuer entity** — the company whose economic exposure is measured.
   Different share classes, ADRs and local listings can resolve to one issuer.
3. **Classification** — sourced, versioned company reference data attached to
   the issuer.

Broker-native positions remain instrument-level. Portfolio look-through is
issuer-level, so `GOOG` and `GOOGL` can aggregate into one Alphabet exposure
without rewriting either broker position.

Ticker is not a global identifier. `SAN` can legitimately denote unrelated
companies on different markets. The catalog therefore stores explicit listing
records and treats ticker and normalized name as multi-valued indexes. A naked
ambiguous ticker remains unresolved until exchange/MIC, an exact identifier,
or an unambiguous issuer name disambiguates it. Only strong identifiers such as
ISIN or FIGI are globally unique and conflicting assignments fail loudly.

## Refresh flow

```text
Trading 212 account positions
            |
            v
dynamic profile resolution (ISIN/ticker/name)
            |
            +---- equity ------> issuer identity + business profile
            |
            `---- fund --------> official/cached constituent snapshot
                                      |
                                      v
                            constituent securities
                                      |
                                      v
                         dynamic issuer enrichment
                                      |
                                      v
                    profile-derived or licensed GICS
                                      |
                                      v
                       portfolio look-through artifact
```

The reference stage runs before look-through. It first resolves every broker
position so that funds are identified from provider metadata, not ticker
membership. It then expands each fund and enriches the underlying economic
equities. The look-through stage consumes the resulting durable catalog
deterministically and performs no network access.

Identity and fundamentals are separate provider steps. Strong identifiers are
batch-mapped through OpenFIGI v3 before Yahoo business-profile enrichment:

```text
ISIN / FIGI
    -> OpenFIGI mapping
       (FIGI family, listing, raw market sector, raw security type)
    -> durable Security Master
    -> Yahoo company profile, when the instrument is an issuer equity
    -> versioned profile-to-GICS crosswalk
```

The raw OpenFIGI `marketSector`, `securityType` and `securityType2` values are
persisted. Trading Max does not maintain a closed enum of provider security
types. It derives only a small routing state:

- `eligible` — confirmed issuer equity that may receive GICS;
- `not-applicable` — confirmed fund or non-equity instrument;
- `pending` — provider facts are insufficient and the system refuses to guess.

`TRADING_MAX_OPENFIGI_API_KEY` is optional. Anonymous installations use
OpenFIGI's smaller public batch and rate limits; a key increases capacity
without changing behavior or the persisted contract.

Issuer-specific download configuration in `BUILTIN_FUND_ADAPTERS` describes
how Trading Max fetches holdings from supported issuers. It is an adapter
registry, not an ETF universe. Any ticker can use a normalized snapshot at
`raw/fund-holdings/<TICKER>.json`; an unsupported fund is reported as
unavailable instead of being treated as a direct company or silently assigned
to a sector.

## Resolution and persistence

The resolver uses exact identifiers in this order:

1. ISIN;
2. FIGI;
3. share-class FIGI;
4. composite FIGI;
5. provider-observed ticker plus exchange or MIC;
6. a globally unique provider-observed ticker alias;
7. normalized provider-observed issuer name.

An unmatched or ambiguous instrument receives a stable `unresolved:*` ID. It
is never merged merely because a ticker looks familiar.

Provider results are stored outside the repository:

- `reference/security-master.json` — runtime-generated catalog;
- `reference/security-master-overrides.json` — optional private,
  operator-reviewed corrections.

Both files carry source and effective-date metadata. Existing records are
retained when an online provider is temporarily unavailable. Overrides are
state, not shipped source code, and are intended for licensed data or reviewed
corrections.

Each account refresh also publishes the merged catalog as the immutable,
content-addressed artifact `reference/security_master.json`. The look-through
stage consumes that exact artifact and records its artifact ID as a dependency;
it does not reread mutable runtime state. A historical portfolio artifact can
therefore be reproduced against the exact identity and classification catalog
used when it was created.

## GICS semantics

GICS is a finite, versioned four-level taxonomy. That finite vocabulary is
expected; the set of companies assigned to it is not finite.

Every stored classification contains:

- sector, industry-group, industry and sub-industry codes and names;
- source, taxonomy version and effective date;
- assignment method (`official`, `derived` or `manual`);
- confidence.

The open-source provider maps live public business-profile metadata to a
versioned GICS node. These assignments are labelled `derived`; they are not
presented as licensed S&P company assignments. A licensed provider can write
`official` records to the same contract without changing portfolio analytics.

No company ticker appears in the taxonomy crosswalk. New securities are
resolved and classified from their identifiers and current business profile.
Unknown profiles remain explicitly pending and material exposure is reported
by the reference-stage quality artifact. Known ETFs, bonds and other
non-company instruments are never sent into the GICS classification path.

Global listings do not require a company seed or a hard-coded
exchange-suffix table. OpenFIGI supplies exact identifiers and local listing
metadata. The Yahoo adapter searches by ISIN, ticker and issuer name, then
ranks venue-qualified symbols such as `9999.HK`, `VWS.CO` or `BMW.DE` using
identifier evidence, issuer-name similarity and profile completeness.
Multiple listings for the same issuer are persisted under one economic
entity; similarly scored matches for different issuers stay pending instead
of being guessed.

This distinction is important:

- the GICS hierarchy is a finite standard vocabulary and is intentionally
  stored as versioned reference code;
- the provider-profile crosswalk maps business descriptions such as
  `Banks—Regional` to that vocabulary and carries its own version and
  confidence;
- the security universe is discovered from broker positions and fund
  constituents at runtime and is never a shipped enum or ticker seed.

The current open-source adapter uses a versioned, schema-validated subset of
the April 2026 GICS structure required by its public-provider crosswalk. The
hierarchy lives under `reference/data`, not in Python source. Deployments can
replace both files through `TRADING_MAX_GICS_NODES_PATH` and
`TRADING_MAX_GICS_CROSSWALK_PATH`, including a licensed full hierarchy or
issuer-level provider. Crosswalk rows reference business profiles, never
tickers, and invalid or duplicate references fail during process startup.

The public-profile adapter is interoperability metadata rather than licensed
issuer-level S&P classifications. Its source, taxonomy version, crosswalk
version, method and confidence are persisted on every derived assignment.

## Coverage contract

`reference/security_master_report.json` publishes:

- economic equity exposure considered after fund expansion;
- classification coverage;
- the per-refresh provider request budget and deferred lower-exposure rows;
- unresolved equity exposure, resolved-but-unmapped equity exposure and
  non-GICS-applicable fund exposure as separate totals;
- material unresolved and unclassified securities, with resolution status;
- provider failures.

Enrichment is exposure-prioritised and coverage-driven. Provider calls execute
in bounded batches and stop once the target economic-exposure coverage is
reached. The operational request budget is configurable through
`TRADING_MAX_SECURITY_PROFILE_REQUEST_BUDGET`; it limits provider load, not the
number of securities the catalog can contain. Cached records are reclassified
against a newer profile crosswalk without repeating provider requests.

`account/lookthrough_metrics.json` schema version 5 publishes:

- canonical entity identity and resolution provenance;
- direct, indirect and total exposure;
- fund contributors;
- optional sourced GICS hierarchy;
- GICS sub-industry allocation and coverage;
- eligible-equity, classified, pending and non-applicable exposure totals;
- explicit `classified`, `pending-identity`, `pending-classification` and
  `not-applicable` statuses.

Fund units themselves do not count as GICS-eligible exposure. Only their
underlying equities do. Cash, derivatives, bonds and an unexpanded fund
residual are labelled `not-applicable`, not `unclassified`, and are excluded
from the eligible-equity coverage denominator. Identity or classification
work that remains for an equity is labelled `pending` instead.
