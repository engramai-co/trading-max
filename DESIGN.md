---
name: Trading Max
description: Calm, evidence-led portfolio intelligence for users who need the truth before the story.
colors:
  signal-blue: "#1768e5"
  signal-blue-light: "#d9e8ff"
  signal-blue-deep: "#1254bc"
  ledger-navy: "#102a52"
  ledger-navy-light: "#164a8a"
  cool-canvas: "#f7f9fc"
  surface: "#ffffff"
  boundary: "#dbe4ef"
  ink: "#111827"
  evidence-teal: "#347985"
  positive: "#2f7a49"
  negative: "#b4473a"
  warning: "#96630e"
typography:
  display:
    fontFamily: 'Inter, "SF Pro Display", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2rem, 4vw, 3.25rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'Inter, "SF Pro Display", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: 'Inter, "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: 'Inter, "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.8125rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.015625rem"
rounded:
  sm: "4px"
  md: "8px"
  lg: "16px"
  xl: "32px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  xxl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 18px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.signal-blue-deep}"
    rounded: "{rounded.md}"
    padding: "0 18px"
    height: "44px"
  card-standard:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  card-money-anchor:
    backgroundColor: "{colors.ledger-navy}"
    textColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  input-standard:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "42px"
  status-chip:
    backgroundColor: "{colors.signal-blue-light}"
    textColor: "{colors.signal-blue-deep}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "24px"
  navigation-active:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    height: "44px"
---

# Design System: Trading Max

## Overview

**Creative North Star: "Portfolio Intelligence"**

Trading Max should feel like a calm control surface for financial truth: exact,
trustworthy, and visibly under the user's control. It is an operational
interface, not a spectacle. Dense account evidence remains scannable because
hierarchy, spacing, and a restrained blue vocabulary make the important state
obvious before interpretation begins.

The visual system pairs cool, quiet working surfaces with a small number of
high-conviction moments. Signal Blue identifies current state and action;
Ledger Navy grounds the most important money facts. The result is layered but
restrained, with ambient depth reserved for genuine hierarchy. It must never
resemble a speculative trading terminal or a flashy cryptocurrency dashboard.

**Key Characteristics:**

- Calm, precise, trustworthy, and controlled.
- Evidence-dense without feeling crowded.
- Cool working surfaces with selective high-contrast anchors.
- Operational states are explicit in text as well as color.
- Bilingual composition remains equally intentional in Chinese and English.

## Colors

The palette is a cool financial workspace anchored by Signal Blue and Ledger
Navy, with semantic colors used only when they carry real status or accounting
meaning.

### Primary

- **Signal Blue:** The active-navigation, primary-action, focus, link, and
  current-state color. It is the clearest directional signal in the interface.
- **Ledger Navy:** The grounding color for high-value account facts, money
  summaries, and other moments that must read as authoritative rather than
  promotional.

### Secondary

- **Evidence Teal:** A supporting chart and classification color. It extends
  the analytical palette without competing with primary actions.
- **Signal Blue Light / Deep:** The light tone supports selected controls and
  status surfaces; the deep tone supplies legible text and pressed emphasis.

### Tertiary

- **Positive, Negative, and Warning:** Semantic profit, loss, risk, degraded
  data, and attention colors. Their meaning is always reinforced by copy,
  symbols, or position.

### Neutral

- **Cool Canvas:** The quiet application background that separates the working
  plane from white content surfaces.
- **Surface:** The default card, input, header, and chart surface.
- **Boundary:** The restrained divider and standard card boundary.
- **Ink:** Primary text and the darkest neutral used for financial facts.

**The Signal Rarity Rule.** Signal Blue marks current state, focus, and action;
it is not general decoration.

**The Ledger Grounding Rule.** Ledger Navy is reserved for the most important
money truth or a compact metric band, never applied to every section.

**The Honest Status Rule.** Semantic color never carries status alone; pair it
with a label, icon, sign, or explicit value.

## Typography

**Display Font:** Inter with SF Pro Display, PingFang SC, and Noto Sans CJK SC
fallbacks.

**Body Font:** Inter with SF Pro Text, PingFang SC, and Noto Sans CJK SC
fallbacks.

**Label/Mono Font:** Labels use the body stack. Monospaced text is limited to
identifiers and code-like evidence, using SFMono-Regular or Consolas.

**Character:** The typography is neutral, compact, and numerically disciplined.
Large titles create orientation; financial values gain authority through size
and weight rather than decorative type.

### Hierarchy

- **Display** (700, fluid 2–3.25rem, 1.08): Page titles and the most important
  account values. Tracking stays tight but never below -0.04em.
- **Headline** (700, fluid 1.35–2rem, 1.2): Major page sections and analytic
  groupings.
- **Title** (700, 1.125rem, 1.3): Card titles, accordion sections, and compact
  summaries.
- **Body** (400, 1rem, 1.55): Explanations, operational copy, and table text;
  prose should normally stay within 65–75 characters per line.
- **Label** (700, 0.8125rem, 1.5): Status chips, compact metadata, and metric
  labels. Uppercase is reserved for short established marks such as TWR.

**The Tabular Truth Rule.** All numbers use tabular numerals so money, ratios,
dates, and changing values remain aligned.

**The Heading Carries It Rule.** Do not add eyebrow or kicker text above a
heading; hierarchy comes from the heading and its spatial context.

## Layout

Trading Max uses a fixed operational shell with a 72px desktop icon rail and a
centered main workspace capped at 1920px. The rail never expands over or pushes
the workspace; full navigation names appear in accessible tooltips. Desktop
content uses 28px outer padding and a 6/10/14/20/28/40px spacing rhythm.
Two-column summaries collapse to a single column as evidence density or screen
width requires.

At the 48em breakpoint, the side rail becomes a 64px top bar and a 72px bottom
navigation area. Mobile preserves the same information hierarchy rather than
shrinking desktop layouts. Touch targets remain at least 44px, data tables use
explicit horizontal scroll regions, and account-detail depth moves into
accordions instead of long unbroken pages.

Page headers orient the workspace with a strong title, a thin neutral divider,
and one short Signal Blue signature line. Controls align to the right on wide
screens and wrap beneath the title when space is constrained.

**The First-Viewport Rule.** Current account state must be findable before
historical interpretation, research, or model commentary.

## Elevation & Depth

The system uses restrained tonal layering with selective ambient shadows.
Ordinary working surfaces are flat or bounded by a quiet 1px line. Shadows are
reserved for the asset anchor, active navigation, allocation overview, and
interactive lift; this keeps depth structural instead of ornamental.

### Shadow Vocabulary

- **Subtle surface** (`0 4px 14px rgba(17, 24, 39, 0.05)`): Low interactive
  lift and compact floating surfaces.
- **Working panel** (`0 10px 28px rgba(17, 24, 39, 0.07)`): Important white
  panels that sit above the Cool Canvas.
- **Money anchor** (`0 20px 48px rgba(15, 42, 82, 0.22)`): The primary account
  value card and no other routine container.
- **Active navigation** (`0 9px 20px rgba(23, 104, 229, 0.24)`): Reinforces the
  current location without turning the rail into a collection of floating
  buttons.

**The Ambient Hierarchy Rule.** Use depth only when an element is meaningfully
above or more important than its neighbors.

**The One Elevation Signal Rule.** A routine card uses either its quiet boundary
or a wide soft shadow; do not stack both treatments by default.

## Shapes

The form language is softly geometric and controlled. Compact controls and
inputs use gently curved 8px corners; standard cards use 16px; only major money
anchors earn the 32px silhouette. Status chips use compact 4px corners. Circles
belong to icons, charts, and true circular data marks rather than general
containers.

Borders are thin, cool, and functional. Clipping is used for accordions and
chart surfaces to preserve clean edges. Pill shapes are limited to segmented
controls and small selection mechanisms whose form communicates grouping.

**The Radius Has Rank Rule.** Larger radii indicate larger structural scope;
do not use the 32px money-anchor radius on routine cards.

## Components

### Buttons

Buttons feel stable and deliberate rather than playful.

- **Shape:** Gently curved corners (8px) with a minimum 44px target.
- **Primary:** Solid Signal Blue with white text and concise action labels.
- **Secondary / Ghost:** White, transparent, or lightly tinted surfaces with
  deep blue text; these never compete with the primary action.
- **Hover / Focus:** A small tonal shift or restrained lift. Keyboard focus is
  a visible 3px Signal Blue ring with separation from the component edge.

### Chips

Chips communicate status and compact metadata, not decoration.

- **Style:** Compact 4px corners, tinted semantic background, high-contrast
  label, and no shadow.
- **State:** Selected or warning meaning is written in text and never inferred
  from hue alone.

### Cards / Containers

Cards are working surfaces with explicit hierarchy.

- **Corner Style:** 16px for standard cards; 32px only for the money anchor.
- **Background:** White for ordinary evidence; Ledger Navy for the primary
  account truth and compact performance metric bands.
- **Shadow Strategy:** Flat or bounded by default; ambient depth only for a
  higher structural layer.
- **Internal Padding:** 20px by default, reduced only where dense tables or
  compact controls require it.

### Inputs / Fields

Inputs should feel native to a serious settings and research tool.

- **Style:** White field, quiet boundary, 8px corners, 42px standard height.
- **Focus:** Signal Blue boundary or focus ring with no decorative glow.
- **Error / Disabled:** Semantic label plus text explanation; never rely on
  red, opacity, or a disabled cursor alone.

### Navigation

Desktop navigation lives on a pale blue 72px rail with the Trading Max mark.
The active item uses a compact Signal Blue gradient, a white filled icon, and
ambient depth. Inactive items are quiet navy icons with a white hover wash;
their full bilingual names appear on hover/focus and remain available to
assistive technology. Mobile navigation moves to the bottom, using
icon-over-label items and a pale blue selected surface.

### Accordions

Accordions progressively disclose evidence without hiding current state. Their
controls are at least 48px high, use the standard 8px shape, and pair a direct
title with status or a concise summary. Account review and strategy detail are
collapsed by default when they are not the page's primary task.

### Segmented Controls

Segmented controls group mutually exclusive account, range, language, and unit
choices. They use a compact tonal container with clear selected contrast and
wrap or scroll before labels become ambiguous.

### Money Truth Panels

The signature component is the Ledger Navy money panel: a high-contrast surface
for current account value or a compact performance metric strip. It combines
large tabular values, short labels, and semantic outcomes without promotional
copy. There is normally one such anchor in a first viewport.

## Do's and Don'ts

### Do:

- **Do** make current account state the strongest item in the first viewport.
- **Do** use Signal Blue for current state, focus, and action.
- **Do** reserve Ledger Navy for the primary money fact or compact metric band.
- **Do** show unavailable, partial, retired, and stale states in explicit text.
- **Do** preserve account-specific semantics and evidence provenance.
- **Do** maintain keyboard, reduced-motion, mobile, Chinese, and English parity.
- **Do** use existing Phosphor icons and Trading Max brand assets.

### Don't:

- **Don't** imitate speculative trading terminals, casino interfaces, or flashy
  cryptocurrency dashboards.
- **Don't** use gradient text, decorative grids, fake market imagery, or motion
  without an operational purpose.
- **Don't** turn every section into a shadowed card or nest cards as page
  structure.
- **Don't** promote model commentary above deterministic account state.
- **Don't** convert missing evidence into zero, invented content, or reassuring
  visual polish.
- **Don't** use color as the only indicator of profit, loss, warning, or status.
- **Don't** add eyebrow labels above headings or uppercase prose as decoration.
