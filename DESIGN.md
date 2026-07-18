# Design System

## Direction

Specbook is a compact monochrome workbench for chats and executable Specs. The interface follows the density and directness of a well-kept technical notebook: persistent project context, strong selected states, quiet surfaces, and no decorative dashboard furniture.

## Color

- Canvas: `#f4f4f3`
- Sidebar: `#f7f7f6`
- Surface: `#ffffff`
- Soft surface: `#f8f8f7`
- Hover surface: `#efefed`
- Text: `#202020`
- Muted text: `#60605b`
- Border: `#e3e3df`
- Primary: `#2b2b2b`
- Success: `#2b8553`
- Danger: `#ba5751`
- Pending: `#aa6420`
- Information: `#406b9f`

Success, danger, and pending are a designed set (OKLCH, matched lightness/chroma band, hues 155°/25°/60°), not three colors picked independently, so they read as a coordinated family instead of clashing.

Color communicates selection, action, or system state. Inactive navigation and content remain neutral.

## Typography

Inter carries the entire product. The desktop scale is deliberately compact: 9.5 to 10.5 pixels for metadata, 11 to 12 pixels for controls and navigation, 12 to 12.5 pixels for messages and body copy, 15 pixels for page headers, and 20 pixels only for a primary content title. Weight and spacing establish hierarchy before size.

## Geometry

- Sidebar: 276 pixels
- Brand and desktop page headers: 72 pixels
- Project switcher: 34 pixels
- Standard fields: 34 pixels
- Compact buttons: 32 pixels
- Chat measure: 780 pixels
- Spec and settings measure: 720 to 790 pixels
- Dashboard measure: 1040 pixels (multi-column data views, not linear reading content)
- Radii: 6, 8, 9, 11, and 13 pixels

The main work surface is white. Canvas gray appears around project creation and in secondary panels, not behind every content block.

## Components

- Project switcher: compact custom menu with project state and a create action.
- Primary navigation: black selected mode with white text; neutral inactive mode.
- Sidebar lists: dense rows with state dots, title, and short metadata.
- Chat: labeled message bubbles, inline live browser, fixed compact composer.
- Spec: readable behavior block, compact actions, run history, and evidence.
- Settings: active model inline; full provider management inside a focused native dialog.
- Runtime: persistent sidebar footer linking to model settings.

## Responsive Behavior

The sidebar becomes a focus-trapped drawer under 768 pixels. Mobile retains the same information architecture and compact type while increasing hit areas only where needed. Forms stack, actions remain visible, dialogs fit within the viewport, and no route may scroll horizontally.

## Motion

Color and drawer transitions run for 150 to 200 milliseconds. Pulses are reserved for active work and connection checks. Reduced-motion preferences disable all nonessential movement.
