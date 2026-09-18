# Allocation chart interaction decision

## Motivation and decision

Country, industry and GICS composition views must expose category, GBP value
and allocation weight without requiring precise hovering over a thin slice.
Select a ring slice or its companion category button to keep a detail panel
visible. Provide the same selection through arrow keys, Home and End. Keep
complete labels and explicit numbers available in native HTML for touch,
keyboard and assistive technology users. Group categories after the first
12 into a selectable remainder whose detail lists its constituents.

The ranking view uses wrapping HTML labels and percentage bars with a fixed
100% track. Do not scale the largest category to 100%; that would misrepresent
its portfolio weight. The detail and ranking views use the supplied allocation
fractions and GBP values, not a percentage recomputed from the displayed top 12.

## Alternatives

Hover-only tooltips are difficult on touch and disappear while reading.
Permanent labels around every ring slice crowd smaller categories. Persistent
details plus category buttons preserve the compact chart and a reliable target.

## Compatibility, privacy and rollback

This is a frontend projection of the existing typed look-through lens. It adds
no endpoint, stored user preference, credential, market data or broker write.
Missing amounts stay unavailable. Category changes reset selection to the new
view. An older frontend can consume the same snapshot without migration.
Reverting the frontend release removes the interaction without rewriting data.

## Validation

Synthetic desktop and mobile browser checks cover direct slice selection,
category buttons, grouped amount/weight totals, selection persistence, switching
dimensions, keyboard navigation and narrow-screen containment. Layout inspection
covers complete long labels and percentage-proportional bar widths.
