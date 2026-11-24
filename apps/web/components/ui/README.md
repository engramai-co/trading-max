# UI component source

Generated shadcn component source lives in this directory.

- CLI: `shadcn@4.23.0` (pinned exact in [package.json](../../package.json))
- Style: `base-luma` ([components.json](../../components.json))
- Primitives: `@base-ui/react`
- Icons: `lucide-react`
- Theming: CSS variables (`tailwind.cssVariables: true`)
- Components added so far: none (toolchain bootstrap only)

With `cssVariables: true`, the first component needs theme aliases for its semantic utilities.
Add an `@theme inline` block in `app/shadcn-theme.css` and import the stylesheet after
`shadcn/tailwind.css` in `app/globals.css`. Map the aliases to the existing tokens, for example
`--color-primary: var(--mx-brand);` gives the component `bg-primary` in both color schemes.
