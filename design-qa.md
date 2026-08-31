# Trading Max Watchlist Design QA

## Evidence

Visual references and browser captures are intentionally kept outside Git.
They can contain private watchlist values, local paths, or third-party source
material. Recreate the evidence locally with a synthetic fixture and the
following state:

- route: `/research?ticker=ARM&view=technical`;
- viewport: 1280 × 720, plus a 390 × 844 mobile pass;
- ARM selected, the relevant GICS Sub-Industry selected, and both locales;
- no real account, watchlist, or API credential data.

The visual intent is to translate the source list hierarchy and security
identity into the Trading Max visual system, not to redistribute or clone a
third-party application's branded UI.

## Primary interactions tested

- GICS Sub-Industry tabs, active-category priority and deterministic count ordering.
- Ticker selection and URL persistence (`ticker` + `view`).
- OpenFIGI company-name search using `Microsoft`.
- Search result identity: company name, ticker, exchange, FIGI and add/open state.
- Technical and Ledger lens switching.
- Chinese and English locale switching.
- Pending, running-capable, ready, partial and failed state styling.
- Next.js and API request logs checked after the final pass; no runtime errors remained.

## Required fidelity surfaces

- Fonts and typography: preserved Trading Max's existing display serif, compact sans-serif labels, optical weights and bilingual hierarchy. Ticker and company name remain separately legible.
- Spacing and layout rhythm: the watchlist is a compact top-level research control, with a scrollable category rail and security rail that do not enlarge the analysis page vertically.
- Colors and tokens: uses the existing paper, ink, olive, amber, teal and brick state tokens; no Trading 212 dark-theme leakage.
- Image quality and assets: existing local company logos are reused. Tickers without a trusted local logo use the product's existing monogram fallback; the app does not transmit the private watchlist to a third-party logo CDN.
- Copy and content: clearly identifies GICS Sub-Industry as the active taxonomy, while the original research themes remain stored for a future LM taxonomy. Bloomberg OpenFIGI remains the security master.

## Comparison history

### Pass 1

- [P2] The active Power & Industrial category was partially clipped at the right edge because the category rail opened at its leftmost scroll position.
- Fix: added active-category `scrollIntoView({ inline: "center" })`.

### Pass 2

- The active category is fully visible and centred.
- No remaining P0, P1 or P2 visual findings.
- Focused evidence was the watchlist header/category/security region in the full browser capture and the source/implementation comparison board; controls and text were readable at that scale, so a separate crop was not required.

### Pass 3 — GICS migration

- Replaced custom-theme tabs with 23 populated GICS Sub-Industries plus Unclassified.
- Active category is rendered immediately after All, followed by categories ordered by watchlist count, so deep-linked tickers never open with their active classification off-canvas.
- Communications Equipment interaction returned exactly NOK, ANET, AAOI, LITE, CSCO and CIEN.
- English locale rendered the official `Communications Equipment` label.
- A 390 × 844 viewport capture confirmed that category and security rails remain horizontally scrollable, search stays usable and the analysis lens controls remain readable.

### Pass 4 — Trading Max master mark

- Reference: the approved repository artwork at
  `apps/web/public/brand/trading-max-primary.png`.
- The navigation
  mark is now a transparent, tightly bounded derivative of the exact symbol,
  rather than a narrow CSS viewport over the square master image.
- The visible lockup keeps the approved typographic contrast: regular
  `Trading`, bold `Max`, neutral sans-serif, with no serif substitution.
- Desktop and mobile navigation preserve the complete right-hand stroke of the
  `M`, the cyan terminal facet, and the original black/blue gradients.

## Final result

final result: passed
