# Dashboard visual QA — TWR, drawdown, allocation, locale

Status: **Passed**

## Visual target

- Preserve the existing Trading Max / Wealthfolio-inspired card system.
- Keep the account-value chart visually unchanged.
- Place TWR and drawdown directly below it, with the same account selector.
- Keep every control usable at desktop and 390 px mobile widths.

## Checks

| Requirement | Result |
| --- | --- |
| Allocation percentages have no positive/negative sign | Passed — overview and holdings show values such as `22.1%` |
| TWR and drawdown chart follows existing card language | Passed |
| Combined, Invest, and ISA selectors work | Passed |
| 1D, 1W, 1M, 3M, 6M, YTD, 1Y, and MAX ranges work | Passed |
| Range TWR rebases from zero | Passed |
| Drawdown recalculates from in-range peaks | Passed |
| Blank CSV values do not become zero wealth | Passed |
| Chinese and English switch persists after reload | Passed |
| Desktop and 390 px mobile layouts remain usable | Passed |

## Evidence

Visual captures are generated locally during QA and are intentionally kept
outside Git. They may contain private portfolio values or third-party source
material. The checked-in application contains only synthetic fixtures and the
approved Trading Max brand asset.

The reproducible evidence set is:

- a desktop capture at the target production viewport;
- a 390 px mobile capture;
- the interaction matrix described below.

## Automated verification

- ESLint: passed
- TypeScript: passed
- Next.js production build: passed
- Browser interaction matrix: 3 accounts × 8 ranges, no `NaN` or infinite values
