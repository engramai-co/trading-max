# UI component source

Generated shadcn component source lives in this directory.

- CLI: `shadcn@4.23.0` (pinned exact in [package.json](../../package.json))
- Style: `base-luma` ([components.json](../../components.json))
- Primitives: `@base-ui/react`
- Icons: `lucide-react`
- Theming: CSS variables (`tailwind.cssVariables: true`, mapped in `app/shadcn-theme.css`)
- Components added so far:
  - `button.tsx` — generated via `shadcn@4.23.0 add button` (`base-luma`, `@base-ui/react/button`), adapted to `DESIGN.md` Palette A tokens, Luma pill geometry, 40/44/32 control sizes, single 2px focus ring, width-stable loading, plus `CloseButton`
  - `copy-button.tsx` — project wrapper over `Button` following Modern Web Guidance `copy-button` (`command="--copy"` / `commandfor` with Safari 16.4 click fallback, Clipboard API + `execCommand` fallback, sibling `role="status"` live region)
  - `text-link.tsx` — shared `TextLink` component supporting workspace `Link`, external anchors, and inline prose links
  - `checkbox.tsx`, `switch.tsx`, `tabs.tsx`, `toggle-group.tsx` (+ `toggle.tsx`), `radio-group.tsx` and `progress.tsx` — generated via `shadcn@4.23.0 add checkbox switch tabs toggle-group radio-group progress` from the [Base Luma registry](https://ui.shadcn.com/), backed by `@base-ui/react`. Adapted to the shared Palette A tokens, workspace sliding selection, labelled native-button hit targets and saving feedback.
