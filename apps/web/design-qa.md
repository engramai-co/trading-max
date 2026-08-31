# Design QA

## Visual target

- Source: the approved Wealthfolio-inspired design direction reviewed during
  product design. The source montage is not redistributed in this repository.
- Adopted language: cream canvas, narrow navigation rail, serif editorial
  headings, low-contrast cards, compact tabular data, olive performance accents
- Deliberately excluded: Wealthfolio name, logo, device mockups, backend logic,
  accounting engine, and branded assets

## Captures

QA captures are generated locally and stored outside the repository because
they can contain account values, private watchlists, or third-party source
material. No screenshot is required to build or run the product.

## Desktop review

- Sidebar density, typography hierarchy, cream palette, card radii, and chart
  treatment visibly match the selected source language.
- No horizontal overflow at default zoom.
- Broker-native total, Invest/ISA cards, allocation, NAV chart, research pulse,
  and holdings remain legible at 1280 px.
- Interactive account chart selector, navigation, holdings filters, research
  tabs, ticker selector, and on-demand refresh control are implemented.

## Mobile review

- 390 × 844 viewport switches to a fixed header, single-column cards, and
  bottom navigation.
- Headline value, freshness badges, hero metrics, allocation chart, and labels
  remain legible without horizontal scrolling.
- Safe-area padding is included for the fixed bottom navigation.
- The compact refresh command remains accessible in the mobile header.

## Engineering checks

- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm run build`: passed
- Production browser routes: passed
- Browser console after hydration fix: no errors
- PDF/CFD surfaces: absent from the product
- Trading 212 credentials: never serialized or read by Next.js

final result: passed
