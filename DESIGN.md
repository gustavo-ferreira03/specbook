# Design System

## Direction

Specbook is a calm, monochrome technical notebook for chats and executable Specs: white surfaces, neutral grays, a near-black primary, hairline borders, and readable type. Color is reserved for status. The Spec is the main surface; automation details stay secondary. Status is always icon plus text, never color alone. No decorative metrics, stat-card grids, or generic SaaS ornament.

All tokens live in `apps/frontend/src/app/globals.css`. Components use only the Tailwind utilities generated from them. Hard-coded colors in components are not allowed, and there are no `accent-*` tokens.

## Color

Each token is a CSS variable (`--sb-*`) defined on `:root` (light) and overridden on `.dark`. `@theme static` exposes it as a Tailwind color (`bg-*`, `text-*`, `border-*`).

| Role | Tokens |
| --- | --- |
| Surfaces | `canvas` (page backdrop), `sidebar`, `surface` (main work area, white / near-black), `surface-soft` (quiet panel), `surface-hover`, `surface-selected`, `surface-raised` (popovers, dialogs), `thumb` (active segment) |
| Lines | `line` (hairline), `line-strong` (field borders), `line-hover` |
| Text | `ink` (primary), `ink-muted` (secondary), `ink-subtle` (tertiary, metadata, placeholders; still AA), `ink-disabled` (non-text only) |
| Primary | `primary` (near-black `oklch(26% 0 0)`; near-white in dark: primary buttons, active tab indicator, progress), `primary-hover` (`oklch(35% 0 0)`), `primary-foreground`, `primary-soft` (quiet filled controls). Selected nav uses `surface-selected` with `ink` text. The focus ring is `ring` (ink). There is no hue accent |
| Inverse | `inverse`, `inverse-foreground` (tooltips, code blocks) |
| Status | `success`, `danger`, `warning` (the original amber "pending"), `invalid`, `conflict`, `info` keep the original palette values. `running` (ink) and `neutral` (gray, for Not run) complete the set. Each has `-soft` (tinted background) and `-chart` (bar fill). Danger also has `danger-soft-hover` and `danger-solid` / `-hover` / `-foreground` for confirm buttons |
| Other | `overlay`, `browser` (live browser frame), `code-canvas`, `syntax-*` (comment, key, string, number, keyword, variable, punctuation) |

The shadcn names (`background`, `foreground`, `popover`, `muted-foreground`, `border`, `input`, `ring`, `destructive`, ...) are aliases, so the shadcn and recharts internals still work. New code does not use them.

Status mapping (`src/lib/status.ts`, the single source of truth):

| Status | Spec label | Run label | Tone | Icon |
| --- | --- | --- | --- | --- |
| `passed` | Passed | Passed | success (green) | Check |
| `failed` | Failing | Failed | danger (red) | X |
| `error` | Error | Error | danger | X |
| `invalid` | Invalid | Invalid | invalid (orange) | AlertTriangle |
| `unverified` | Not run | Not run | neutral (gray) | CircleDashed |
| `running` | Running | Running | running (ink) | LoaderCircle (spins) |
| `conflict` | Conflict | Conflict | conflict (violet) | GitMerge |

Every text and background pair meets WCAG AA (4.5:1) in both themes, including `ink-subtle` on `surface-selected` and status text on its `-soft` tint. Dark mode is the same system inverted: neutral grays with no tint, a near-white primary, and lighter status tones on dark tints.

## Typography

Inter (`font-sans`) carries the UI. JetBrains Mono (`font-mono`) is only for URLs, paths, hashes, and code. Weights are 400, 500 (controls, emphasis), and 600 (headings). 700 is not used.

| Utility | Size / line height | Use |
| --- | --- | --- |
| `text-label` | 11 / 16, 600, +0.06em | Uppercase eyebrow (`.eyebrow` class). Use sparingly |
| `text-meta` | 12 / 18 | Metadata, timestamps, counts, badges, breadcrumbs |
| `text-control` | 13 / 20 | Buttons, inputs, menus, nav rows, dense lists |
| `text-body` | 14 / 22 | Body copy, messages, Spec text (the `body` default, line height 1.55) |
| `text-section` | 15 / 22, 600 | Section and dialog titles |
| `text-title` | 21 / 28, 600, -0.015em | Page title (one per route) |
| `text-display` | 28 / 36, 600 | Onboarding hero only |

Use `.tabular` (tabular numbers) for counts, durations, and times. Arbitrary sizes such as `text-[0.6875rem]` are not allowed. `lib/utils.ts#cn` knows these names, so `tailwind-merge` does not drop them.

## Geometry and elevation

- Radii: `rounded-sm` 6, `rounded-md` 8 (controls, rows), `rounded-lg` 10 (menus, panels), `rounded-xl` 12 (cards, composer), `rounded-2xl` 14 (dialogs), `rounded-full` (pills, avatars).
- Measures: `max-w-reading` 760 (Spec, settings, forms), `max-w-chat` 780, `max-w-data` 1080 (lists and dashboards). Sidebar width: `w-sidebar` (272).
- Rhythm: 4px grid. Page gutters are 16 (mobile) and 32 (desktop). Sections are 24 to 32 apart, and rows inside a section 8 to 12.
- Heights: buttons `sm` 32 and default 36, icon buttons 36 / 32 / 28 (`icon-xs`, for dense row actions only), fields 36, nav rows 32 (40 on touch).
- Shadows: `shadow-xs` (buttons, fields, active segment), `shadow-popover` (menus, tooltips, selects), `shadow-dialog` (dialogs, drawer), `shadow-composer`. Everything else is flat with 1px `line` borders.

## Components (`src/components`)

- `ui/button`: variants `default`/`primary` (near-black, one per view), `outline`/`secondary`, `subtle` (`primary-soft` fill), `ghost`, `destructive` (solid, confirm only), `destructive-soft`, `link`; sizes `sm`, `default`/`md`, `lg`, `icon`, `icon-sm`, `icon-xs`, `icon-lg`. `focusRing` exports the shared focus recipe.
- `ui/input`, `ui/textarea`, `ui/select`: 36px, `line-strong` border, hover darkens the border, focus darkens the border and adds a soft ink ring, and `aria-invalid` turns it danger. `fieldClasses` is exported for custom fields.
- `ui/tabs`: `TabsList variant="underline"` (default, 2px ink indicator) or `"segmented"` (tinted track with a raised thumb).
- `ui/badge`: soft tones (`secondary`, `neutral`, `success`, `danger`, `warning`, `invalid`, `conflict`, `info`, `running`), sizes `default` 24 and `sm` 20.
- `ui/alert`: tones `default`, `info`, `success`, `warning`, `danger` (alias `destructive`), `invalid`, `conflict`.
- `ui/dialog`, `ui/alert-dialog`, `ui/sheet`, `ui/dropdown-menu`, `ui/tooltip`: raised surface, hairline border, token shadows. Tooltips use `inverse`.
- `StatusPill` (`status`, `kind="spec"|"run"`, `size`), `StatusDot` (`status`, `size`): icon plus label from `lib/status`.
- `PageHeader` (`title`, `breadcrumbs`, `meta`, `description`, `actions`, `titleAdornment`, `width`, `bordered`) and `PageContainer` (`width`): the single header of a route. The breadcrumb lists ancestors only. The title is never repeated below the header.
- `SectionHeader` (`title`, `count`, `description`, `actions`, `as`).
- `SummaryStrip` (`counts`, `noun`, `showBar`, `trailing`) and `StatusBar` (`counts`): "9 Specs · 2 failing · 1 not run · 5 passing" with a 6px stacked bar. They replace stat cards.
- `EmptyState` (`icon`, `title`, `description`, `action`, `secondaryAction`, `tone` neutral/danger/success/warning, `size`): an icon in a tinted circle, one title line, one help line, and one primary action.
- `RelativeTime` (`value`, `prefix`): "5 minutes ago", with the absolute time in `title`. It shares one ticker across the page.
- `MetaList` / `KeyValue` (`items`, `layout="inline"|"grid"`): metadata lines and definition lists.
- `LogoMark` (`className`, `inverse`): the original mark (`public/specbook-logo.svg`, or the dark tile `specbook-chat-icon.svg` with `inverse`). Keep it unchanged. On dark surfaces add `dark:invert` to the plain mark.
- `ThemeToggle`: Light / System / Dark radio group.

## App shell

The sidebar has, from top to bottom: brand (56px), project switcher, segmented Chats / Specs control, a section label with a muted count and one action, a scrolling list, and a footer. The footer holds the model status (links to `settings?tab=model`), the Settings link, and the ThemeToggle.

- The segmented control follows the route. `/specs/*` and `/features/*` show Specs, and `/chats/*` shows Chats. Other routes keep the last list shown.
- Rows are 32px. The selected row is `surface-selected` with `ink` text. Feature children sit on a hairline rail.
- Row actions (run, edit, delete) appear on hover and on `focus-within`, over a fade in the row color. On touch devices (`hover: none`) they are always visible.
- Under 768px the sidebar becomes a focus-trapped drawer, opened from a 56px top bar.

## Project Overview

Overview is the single entry for autonomous activity and review. Its sidebar badge counts decisions that need an answer, including requests to turn an uncovered bug into a regression check. The header states the current check results and last check; the same per-Spec health feeds the status dots in the feature tree.

Sections stay in this order: Needs you, Failing, Recent runs. Use compact rows with one sentence, an icon, time and one action. Failing lists the current triage state per Spec. Recent runs group by trigger: deployment, CI, schedule, manual or check changes. Empty sections are hidden; an empty project gets the existing EmptyState. Pause is a minor header control; coverage analysis and exploration live in the Actions menu and require an explicit request.

Open evidence, a chronological timeline and decision actions in the existing right-side Sheet. Questions explain what accepting them will change. Keep screenshots and readable behavior visible inside the sheet; put file diffs and logs under collapsed Technical details. Do not repeat the row title as a timeline event or add generic investigation narration.

## Dark mode

`.dark` on `<html>` switches every token. The default follows `prefers-color-scheme`. The user's choice (`light`, `dark`, or `system`) is stored in `localStorage["specbook:theme"]`, and every access is wrapped in try/catch. An inline script in `app/layout.tsx` (`lib/theme-script.ts`) applies it before first paint. `lib/theme.ts` provides `useThemePreference` and `setThemePreference`. In dark mode the main surface is near-black, the sidebar and canvas are slightly darker, and elevation comes from lighter raised surfaces and stronger shadows. Primary buttons are near-white with near-black text.

## Motion

Color, background, border, and opacity transitions last 150ms. Dialogs and menus fade and zoom in over 150ms. The drawer slides over 200ms. Spinners and `.status-pulse` are reserved for active work. `prefers-reduced-motion` disables all nonessential animation.

## Accessibility

- Focus: a 2px ink ring with a 2px offset on every interactive element (inset on list rows).
- Status is always icon plus text. Icon-only status (`StatusDot`, `StatusBar`) has an accessible name.
- Icon buttons have an `aria-label` and a tooltip.
- Hit areas are at least 32px on desktop and 40px on coarse pointers.
- Row actions stay keyboard-reachable. They appear when focus enters the row.
- No route scrolls horizontally at 390px. Page actions wrap below the title on narrow screens.
