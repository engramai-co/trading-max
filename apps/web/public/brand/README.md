# Trading Max brand assets

The mark is a solid `T + M` monogram. The `T`'s bar spans the whole
symbol and its stem stands flat on the baseline between the `M`'s legs; the
`M`'s diagonals carry the accent colour. It uses the workspace's own colours:

- near-black `#17191c` for the `T` and the `M`'s legs;
- cobalt `#1768e5` for the `M`'s diagonals;
- on dark backgrounds, `#f2f3f5` and `#5b9dff`.

`trading-max-primary.png` is the approved design-review reference. The SVG
files are the source assets for product surfaces:

- `trading-max-symbol.svg` — full-colour standalone symbol;
- `trading-max-symbol-mono.svg` — current-colour monochrome symbol;
- `trading-max-lockup.svg` — horizontal lockup for light backgrounds;
- `trading-max-lockup-dark.svg` — horizontal lockup for dark backgrounds;
- `trading-max-app-icon.svg` — white app-icon tile for desktop and touch icons;
- `trading-max-social.svg` — 1200 × 630 social preview;
- `trading-max-engram-lockup.svg` — optional `an Engram project` endorsement.

`trading-max-mark.png` is a 1024 px raster of the symbol. The browser icon
(`apps/web/app/icon.svg`) and the desktop connection screen
(`apps/desktop/splash/icon.svg`) switch to the dark colours with the system
appearance; the workspace sidebar draws the same paths from `ui/brand-mark.tsx`.

Keep the stem flat-ended and the gaps between the bar, legs and stem open; they
keep the `T` legible in one colour. Do not add K-lines, arrows, coins,
bull/bear illustrations, or currency signs to the mark. Product status colours
are not brand colours.

The wordmark uses a system sans fallback so the SVG remains self-contained;
production brand exports should preserve the same optical proportions and use
the same approved colour values.
