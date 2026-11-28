/**
 * Single JS mirror of the viewport breakpoints declared in app/shadcn-theme.css.
 * lib/breakpoints.test.ts asserts that every pixel threshold here matches CSS.
 */
export const BREAKPOINTS = {
  narrowMax: 375,
  phoneMax: 767,
  tabletMax: 959,
  phoneLandscapeMaxHeight: 500,
  wideMapMin: 1180,
  desktopMax: 1199,
  wideMin: 1280,
  researchIndexMaxEm: 48,
} as const;

/**
 * The four core viewport breakpoint queries (narrow, phone, compactDesktop, wide)
 * plus the exact composite, em-based, and pointer queries used across the workspace.
 */
export const MEDIA_QUERIES = {
  narrow: `(max-width: ${BREAKPOINTS.narrowMax}px)`,
  phone: `(max-width: ${BREAKPOINTS.phoneMax}px)`,
  researchIndexPhone: `(max-width: ${BREAKPOINTS.researchIndexMaxEm}em)`,
  desktop: `(min-width: ${BREAKPOINTS.phoneMax + 1}px)`,
  phoneDock: `(max-width: ${BREAKPOINTS.phoneMax}px), (max-width: ${BREAKPOINTS.tabletMax}px) and (max-height: ${BREAKPOINTS.phoneLandscapeMaxHeight}px) and (pointer: coarse)`,
  shortLandscapeDock: `(max-width: ${BREAKPOINTS.tabletMax}px) and (max-height: ${BREAKPOINTS.phoneLandscapeMaxHeight}px) and (orientation: landscape) and (pointer: coarse)`,
  touchLayout: `(max-width: ${BREAKPOINTS.phoneMax}px), (hover: none) and (pointer: coarse)`,
  wideMap: `(min-width: ${BREAKPOINTS.wideMapMin}px)`,
  compactDesktop: `(max-width: ${BREAKPOINTS.desktopMax}px)`,
  wide: `(min-width: ${BREAKPOINTS.wideMin}px)`,
  finePointer: "(hover: hover) and (pointer: fine)",
  reducedMotion: "(prefers-reduced-motion: reduce)",
} as const;

export type MediaQueryName = keyof typeof MEDIA_QUERIES;
