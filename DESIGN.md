---
name: Specbook
description: Living, executable Specs for web applications
colors:
  ink: "oklch(27.5% 0 0)"
  ink-muted: "oklch(45% 0 0)"
  ink-subtle: "oklch(51% 0 0)"
  surface: "oklch(100% 0 0)"
  canvas: "oklch(100% 0 0)"
  surface-hover: "oklch(96.5% 0 0)"
  surface-selected: "oklch(94% 0 0)"
  line: "oklch(92.5% 0 0)"
  line-strong: "oklch(87.5% 0 0)"
  primary: "oklch(26% 0 0)"
  dark-surface: "oklch(20.5% 0 0)"
  dark-canvas: "oklch(16.5% 0 0)"
  dark-ink: "oklch(94.5% 0 0)"
  dark-line: "oklch(28.5% 0 0)"
  success: "#1f8559"
  danger: "#bd5149"
  warning-icon: "#b07800"
  invalid: "#9a5212"
  info: "#406b9f"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: "2.5rem"
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: "1.375rem"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.375rem"
  control:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    lineHeight: "1.25rem"
  meta:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    lineHeight: "1.125rem"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontFeature: "tnum"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  2xl: "12px"
spacing:
  grid: "4px"
  gutter-mobile: "16px"
  gutter-desktop: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
  step-number:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    size: "24px"
---

# Design System: Specbook

## 1. Overview

**Creative North Star: "The Spec Sheet"**

Specbook reads like a precise technical document that happens to run. Monochrome and high contrast: graphite ink on white, charcoal in dark mode, hairline structure, and colour only where it carries status. Light gray fills are avoided; the one place gray marks state is the current item in the sidebar. Identity comes from typography. Geist carries the interface with firm, slightly tightened headings; Geist Mono is the data voice for numbers only (durations, counts, step numbers, routes, ids), never for prose.

It rejects the generic shadcn look (tinted gray panels, soft pills, default black button on gray), the terminal look (dark hacker chrome, code in front), and anything colourful or decorative.

**Key Characteristics:**
- Pure neutrals at chroma 0. No warm or cool tint.
- One content surface. The sidebar shares it and is separated by a hairline, not a gray band.
- Status is icon plus coloured text, never a filled pill, never colour alone.
- Structure through 1px lines and spacing; no nested cards, no side-stripe accents, no uppercase eyebrows.

## 2. Colors

A strict monochrome with a small status palette.

### Neutral
- **Ink** (oklch(14.5% 0 0)): text, primary buttons, focus ring, selection.
- **Ink muted / subtle** (oklch(40%) / oklch(49%)): secondary text and metadata; both pass AA on every surface.
- **Surface** (white) and **Canvas** (oklch(98.5%)): content and page backdrop. Hover oklch(96.5%), selected oklch(94%).
- **Line / Line strong** (oklch(92.5%) / oklch(87.5%)): hairlines and field borders.
- Dark mode mirrors it: canvas oklch(10%), surface oklch(13%), lines oklch(24%), ink oklch(96.5%), near-white primary.

### Status
Success green, danger red, warning amber (icons and dots only; warning text stays ink), invalid orange, info blue. Each has a `-soft` tint for rare filled contexts and a `-chart` fill. Status mapping lives in `src/lib/status.ts`.

## 3. Typography

Geist (sans) for everything people read; Geist Mono only through the `.tabular` utility and `font-mono` for routes, ids and code. Weights 400, 500 and 600. Scale: meta 12, control 13, body 14, section 15/600, title 24/600 at -0.025em, display 32/600 at -0.03em (onboarding only). Nothing below 12px. Relative times ("2 hours ago") stay in sans; only the numbers that follow them (durations, counts) switch to mono.

## 4. Elevation

Flat. Surfaces are separated by hairlines and spacing. Shadows exist only for things that float: popovers and menus (short, 8px-class blur with a 1px base), dialogs, and the chat composer. Panels never combine a border with a wide soft shadow.

## 5. Components

- **Buttons:** 36px (32px small), 6px radius, verb plus object labels. Hover inverts: primary (solid graphite) turns transparent with a graphite outline and text; outline turns solid graphite with white text; icon-only ghost buttons fill with graphite. Content inside inherits the button colour on hover. Split buttons invert as one group. Disabled primary is an outline with subtle text, never a gray block. 320ms, ease-out-quint, instant under reduced motion.
- **Panels:** white, 1px line, 10px radius. Content inside a panel is divided by hairlines, never by inner cards.
- **Status:** `StatusPill` renders icon plus coloured label with no background. Coverage uses a 6px dot plus label.
- **Spec steps:** 24px square step numbers (6px radius, strong hairline, mono numeral) joined by a hairline.
- **Expected result:** a full-border panel with an icon label; no side stripe.
- **Tables:** sentence-case header in meta/600, group rows on canvas, numbers in mono, right-aligned.
- **Navigation:** the Chats/Specs switch uses solid graphite for the active segment; the current sidebar row uses `surface-selected` gray. Filter chips are inverted when active. Disclosure chevrons never invert.
- **Chat:** the user's own messages are graphite bubbles with white text; agent messages sit on the surface.
- **Access screens (login, invitation):** a 360px form column with labels above full-width fields, and on wide screens a graphite panel typesetting a sample Spec whose steps check off once on load.

## 6. Do's and Don'ts

- Do use tokens from `apps/frontend/src/app/globals.css` only. Never hard-code colours.
- Do put numbers in Geist Mono via `.tabular`; don't put sentences in mono.
- Do show status as icon plus text.
- Don't add filled status pills, light gray fills, uppercase tracked labels, side-stripe borders, nested cards, gradients or decorative illustration.
- Don't introduce a hue accent. Colour means status.
- Don't go below 12px or above 12px radius on panels.
