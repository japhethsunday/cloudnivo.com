---
name: CloudNivo Console
description: A dark instrument board where state owns regions and blue is reserved for action.
colors:
  ground: "#0e1930"
  ground-muted: "#0b1527"
  panel: "#0c1729"
  inset: "#081120"
  overlay: "rgb(3 7 13 / 0.72)"
  hairline: "#1c2738"
  hairline-strong: "#2f3e56"
  ink: "#e9eef7"
  ink-muted: "#9aa8bd"
  ink-faint: "#7d8ba3"
  accent: "#4d8dff"
  accent-hover: "#6fa3ff"
  accent-contrast: "#05101f"
  accent-soft: "#15254a"
  accent-faint: "#101b33"
  accent-ink: "#a6c6ff"
  success: "#35c88a"
  success-soft: "#0c2b21"
  success-ink: "#4ed6a0"
  warning: "#f2b544"
  warning-soft: "#33260d"
  warning-ink: "#f8c766"
  danger: "#fa7268"
  danger-soft: "#38191a"
  danger-ink: "#ff8f86"
  info: "#45a5f5"
  info-soft: "#0d2639"
  info-ink: "#6fbcff"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif"
    fontSize: "40px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.012em"
  body:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.006em"
    fontFeature: "'cv11', 'ss01'"
  control:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "-0.004em"
  channel-label:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.09em"
  reading:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.005em"
    fontFeature: "tabular-nums"
  gauge-key:
    fontFamily: "{typography.reading.fontFamily}"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  hairline-box: "3px"
  panel: "4px"
  overlay: "6px"
spacing:
  hair: "4px"
  tight: "8px"
  snug: "12px"
  panel: "16px"
  page: "24px"
components:
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px 16px 16px"
  panel-header:
    backgroundColor: "{colors.ground-muted}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.channel-label}"
    padding: "10px 16px"
  panel-alarm:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px 16px 16px"
  button:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.overlay}"
    padding: "7px 13px"
  button-hover:
    backgroundColor: "{colors.ground-muted}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-contrast}"
    typography: "{typography.control}"
    rounded: "{rounded.overlay}"
    padding: "7px 13px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-contrast}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.overlay}"
    padding: "7px 13px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.overlay}"
    padding: "7px 13px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.overlay}"
    padding: "7px 10px"
  badge:
    backgroundColor: "{colors.ground-muted}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.reading}"
    rounded: "{rounded.hairline-box}"
    padding: "2px 8px"
  badge-ok:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success-ink}"
  badge-warn:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning-ink}"
  badge-bad:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-ink}"
  badge-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-ink}"
  state-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    padding: "10px 12px 10px 10px"
  gauge-cell:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "12px 14px"
  status-strip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "10px 14px"
  section-rail-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.control}"
    padding: "8px 10px"
  menu:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline-box}"
    padding: "5px"
---

# Design System: CloudNivo Console

## Overview

**Creative North Star: "The Instrument Face"**

The console is read the way an operator reads a panel of gauges: the ground is
dark and continuous, the panels are *cut out of* that ground by hairlines rather
than floated on top of it, and every reading sits at a fixed position so a scan
down a column is one motion. Nothing here is a document. Titles are small,
descriptions are short, and the largest thing on most screens is a number or a
state word, not a heading.

State is the subject of the whole system, and it owns whole regions. A degraded
primitive colours its row's entire left edge and tints the row's ground; an
alarming panel wears the alarm on its border and its header band. A coloured dot
is never the whole answer. CloudNivo blue is the identity and the action colour
only — a blue element is something you press, follow, or are currently on, never
something that is "fine."

Dark is the designed scene and light is derived from it: `:root` carries the
instrument tokens and `[data-theme='light']` restates the same roles in
daylight. Geometry, density, type and hairline structure are identical across
both; only the ground and the inks invert. The theme provider defaults to dark.

**Key Characteristics:**

- Near-navy ground (#0e1930), never black, with panels one step off it.
- Hairline separation instead of shadow; panels carry no resting shadow at all.
- Square-ish geometry on a 4px grid (4px panels, 3px chips).
- Left-edge state bands on rows, panels and banners, with a mono state word.
- Tabular mono for every measured value: telemetry, IDs, regions, timestamps.
- 14px base body; 20px is the largest routine heading. Density over scale.

## Colors

Cool, low-chroma navy neutrals with four saturated signal hues that appear only
where something is being reported, plus one blue that is reserved entirely for
agency.

### Primary

- **Signal Blue** (`accent`): The identity and action colour. Primary buttons,
  links, focus outlines, the active tab underline, the selected command-palette
  row, the in-progress edge pulse, and meter fills for ordinary usage. Its soft
  and faint variants (`accent-soft`, `accent-faint`) are the only blue *fills*:
  focus rings, the active account-nav item, the current nav child, the active
  stepper step, the project tag in the rail. `accent-ink` is the blue that may
  be set as text on a blue-soft surface.

### Secondary

The status hues. Each ships as a trio: the pure hue for edges, icons and bar
fills; `*-soft` as a tinted surface; `*-ink` as the only text colour permitted
on that surface.

- **Live Green** (`success`): a healthy primitive's row edge, a completed
  provisioning step, an ok badge, a confirmation flash.
- **Attention Amber** (`warning`): degraded or in-transition state — pending,
  provisioning, retrying, building, deploying. Tints the row ground at 7%.
- **Alarm Coral** (`danger`): failure, error, expiry, destructive actions, the
  notification count, the production environment badge. Tints the row ground at
  9% and takes the whole panel edge on `.card.alarm`.
- **Notice Blue** (`info`): informational banners, low-severity findings, and
  info toasts. Deliberately a different blue from the accent so a notice is never
  mistaken for an action.

### Neutral

- **Instrument Ground** (`ground`): the page field behind everything.
- **Strip Ground** (`ground-muted`): the app strip, the rail, table heads and
  panel header bands — the chrome that frames a panel.
- **Panel** (`panel`): every card, menu, modal, toast, input and gauge face.
  Note that it sits *at or below* the ground's lightness: panels are cut out,
  not lifted.
- **Inset** (`inset`): recessed surfaces — code blocks, copy fields, kbd keys,
  meter tracks, the theme switch trough.
- **Hairline** / **Hairline Strong**: the entire depth system. The plain
  hairline separates; the strong one marks an interactive or focused boundary
  (button borders, input borders, hovered panels, active nav).
- **Ink / Ink Muted / Ink Faint**: primary text, secondary and label text, and
  the quietest metadata. All three pairs are measured against every surface they
  land on and currently clear WCAG AA in both scenes.

### Named Rules

**The Blue-Is-Not-A-Status Rule.** `accent` means *act on this* or *you are
here*. It may never encode health, severity, or condition. A blue edge on a row
means work is in progress under the operator's own action, and nothing else.

**The Ink-On-Soft Rule.** Text drawn on a `*-soft` surface uses that hue's
`*-ink` token, never the pure hue. The pure hue is for 3px edges, icons, and bar
fills, where contrast is carried by mass rather than by stroke.

**The Derived-Daylight Rule.** Light theme changes values, never roles. If a new
token is added to `:root`, it is added to `[data-theme='light']` in the same
pass, with both scenes measured for AA.

## Typography

**Display / Body Font:** Inter, with `ui-sans-serif` and the platform stack
behind it, running `cv11` and `ss01`.
**Label/Mono Font:** the platform mono stack (SF Mono / Menlo / Consolas).

**Character:** One sans carries every heading, label and sentence; the mono
carries everything that was *measured*. The split is semantic, not decorative —
if a value came off a backend read, it is set in mono with tabular figures, and
if it is language, it is set in Inter with tight negative tracking.

### Hierarchy

- **Display** (650, 40px, 1.0): reserved for the single large scoreboard figure
  — the security posture score. Nothing else on the console is this size.
- **Headline** (600, 17px): the page heading and the workspace strip title.
  This is the top of the everyday ramp; the base `h1` is 20px and appears only
  outside the strip-led pages.
- **Title** (600, 15px): panel and section headings, empty-state titles, modal
  titles. Sub-headings inside a panel drop to 13px.
- **Body** (400, 14px, 1.55): all prose, at 72–78ch maximum measure for
  descriptions.
- **Control** (500, 13.5px): buttons, nav items, tabs, table cells, menus,
  rows, toasts — the console's real working size.
- **Channel Label** (600, 11.5px, +0.09em, uppercase): a panel header band
  naming what the panel reports. Table heads and gauge keys are the same idea at
  11px/10.5px with +0.07–0.08em.
- **Reading** (mono, 11.5–12.5px, tabular): state words, row details, table
  readings, meter values, the strip's metadata line, badges.

### Named Rules

**The Channel-Label Rule.** Uppercase letterspaced type exists only inside panel
chrome, where it names a channel: a panel header band, a table head, a gauge
key, a nav group label. It never appears above a heading as a kicker or eyebrow,
and it is never a standalone line of content.

**The Measured-Value Rule.** Anything read off the backend — state words,
regions, identifiers, timestamps, counts, sizes, durations — is mono with
`font-variant-numeric: tabular-nums`, so a column of values aligns and a
changing value does not reflow its neighbours.

**The State-In-Words Rule.** Every coloured state band is accompanied by the
state spelled out in a mono word, in that state's `*-ink` colour, at a fixed
column width (96px right-aligned in panel rows). Colour alone never carries the
meaning.

## Layout

A two-column shell: a fixed 236px section rail (collapsing to a 76px icon rail,
becoming an off-canvas drawer under 900px) and a content column capped at
1220px. A low-profile sticky app strip sits at the top of the content column
with a translucent, blurred ground.

Inside a project, the workspace header and its section rail are one welded
instrument: `.ws-head` carries identity, live state and the primary action with
square bottom corners; `.tabs-row` carries the section tabs with square top
corners and no seam between them. Both are sticky (44px and 108px) on desktop
and go static under 900px. `.subtabs` is the same grammar one level quieter for
in-page views, and `.jump-nav` — plain links, deliberately not styled as tabs or
buttons — is used only where a long section renders all its panels at once and
the nav merely moves the viewport.

The board is the signature layout: `.board-main` is a 1.85fr / 1fr grid pairing
the wide system-state panel with a narrow activity column, collapsing to one
column at 1080px. The generic two-column overview is 1.4fr / 1fr, collapsing at
980px. Card grids auto-fill at 240px minimum; the gauge strip auto-fits at 150px
so cells share the face equally rather than leaving one stretched.

Spacing runs on a 4px grid: 4px between related controls, 8px within a cluster,
12px between panels and between a heading and its body, 16px panel padding and
section separation, 24–28px page padding (16px/12–14px on small screens).
Breakpoints in use: 1080px (board), 980px (overview grid), 900px (shell and
sticky behaviour), 720px (gauge strip stacks), 700px, 640px, 560px.

## Elevation & Depth

**There are no resting shadows.** `--shadow-sm` is `none` in both themes, and
`.card` sets `box-shadow: none` explicitly. Depth is tonal and linear: the
ground, panels cut from it, insets recessed below it, and hairlines marking
every boundary. Hover raises a border, not a surface — `border-color` moves from
hairline to hairline-strong.

Shadow exists only for things that genuinely float above the page: menus,
modals, toasts, the notification panel, the command palette, and the mobile
drawer. The primary button carries a small shadow plus a blue glow in dark mode;
that is the one control allowed to sit forward, because it is the one control
that is always the answer.

### Shadow Vocabulary

- **None** (`--shadow-sm: none`): the resting state of every panel, stat, badge,
  row and strip.
- **Overlay** (`--shadow-md: 0 8px 28px -12px rgb(0 0 0 / 0.7)`): dropdown
  menus, toasts, the mobile nav drawer.
- **Deep Overlay** (`--shadow-lg: 0 20px 56px -18px rgb(0 0 0 / 0.78)`): modals,
  the command palette, the notification panel.

### Named Rules

**The Cut-Not-Floated Rule.** A panel is defined by its hairline and its tonal
step, never by a shadow. If a surface needs a shadow to be legible against its
ground, the ground relationship is wrong.

**The Overlay-Only Rule.** Shadow is permission to overlap other content. If an
element is in the document flow, it gets no shadow.

## Shapes

Square-ish and dense. 4px is the panel radius and the default; 3px is the chip
radius used for badges, menus, banners, insets, and small interactive tiles;
6px is the control radius used by buttons, inputs, menu items and modals. The
form language is rectangular: full-width header bands with only their top
corners rounded, welded strip pairs where one element's bottom corners and the
next element's top corners are both squared, and hairline-divided cell strips
rather than gaps between separate boxes.

The one recurring non-rectangular form is the circle, used only for genuinely
round things: status dots (8px), avatars, provisioning step markers, and the
notification count pill.

The system's signature stroke is the **3px left edge**. It appears on health
rows, table rows, feed items, banners and alarming panels, always carrying
state, always in the state's pure hue, and always transparent when there is no
state to report.

### Named Rules

**The Three-Pixel-Edge Rule.** State on a row or panel is a 3px left border in
the state's hue, plus a ground tint for warn (7%) and bad (9%). Not a border on
all four sides, not a background swap, not a dot alone.

**The Hairline Divider Rule.** Adjacent readouts share one bordered face and are
divided by hairlines (`.stat-grid` / `.stat`). They are not separate cards with
gaps between them.

## Components

### Buttons

- **Shape:** softly squared (6px), 7px/13px padding, 13.5px at weight 500, with
  a 1px depress on `:active`.
- **Default:** panel ground, strong hairline border, primary ink. Hover darkens
  to the strip ground.
- **Primary:** accent fill with `accent-contrast` ink (near-black in dark, white
  in light), weight 600. Hover moves to `accent-hover`. This is the only filled
  button; there is at most one per strip or panel header.
- **Danger:** transparent with a coral border and coral text; hover fills with
  `danger-soft`. Destructive actions are outlined, never filled.
- **Quiet:** transparent, muted ink, fills with inset on hover. Used for
  in-panel secondary actions.
- **Icon button:** 34px (28px small) square-ish tile, panel ground, hairline
  border, hairline-strong on hover.
- **Focus:** a 2px accent outline at 2px offset globally; inset to -2px inside
  nav, tabs and list rows so it does not clip.

### Chips

- **Badge:** mono, 11.5px, lowercase, 3px radius, `*-soft` background with
  `*-ink` text and a transparent border. Lowercase is the tell that a badge is
  reporting a machine value.
- **Environment badge:** the exception — uppercase with +0.05em. Production
  carries a full coral border so it can never be mistaken for preview or
  development.
- **Severity tag:** mono, capitalised, `*-soft` on `*-ink`, keyed high/medium/low
  to danger/warning/info.

### Cards / Containers

- **Corner Style:** 4px.
- **Background:** panel, on the ground, with a 1px hairline. No shadow.
- **Header band:** the first `.section-head` or `h2` inside a card bleeds to the
  card's edges, takes the strip ground, a bottom hairline, and channel-label
  type. This is what makes a card read as an instrument panel rather than a box
  with a title.
- **Internal Padding:** 14px top / 16px sides / 16px bottom; an empty state
  inside a card drops to 24px/16px and does not reserve a screenful.
- **Alarm variant:** coral border with a 3px left edge, a 7% coral ground tint,
  and a 12% coral header band with a coral bottom rule.

### Inputs / Fields

- **Style:** panel ground, strong hairline border, 6px radius, 7px/10px padding,
  full width; selects draw their own inline chevron (theme-aware) with no native
  appearance. Textareas are mono.
- **Focus:** border becomes accent with a 3px `accent-soft` ring (a 22% blue
  ring in dark).
- **Disabled:** 0.6 opacity, no other change.
- **Field:** stacked 13px label, control, 12px muted hint, 14px bottom margin;
  `.form-row` lays fields inline and aligns the submit to the inputs rather than
  to the labels.

### Navigation

- **Rail:** 13.5px weight-500 muted items with 18px icons at 0.62 opacity, 3px
  radius, grouped by hairline-separated blocks under uppercase group labels.
  Current page takes the panel ground, a strong border, weight 600 and full-
  opacity icon. Children indent to 35px and take an `accent-faint` ground when
  current.
- **Tabs:** underline tabs — 2px transparent bottom border going accent when
  current, with the label going full-ink and weight 600. The strip masks its
  right edge on overflow and hides its scrollbar; an overflow menu sits outside
  the scroll container so its dropdown is not clipped.
- **Mobile:** under 900px the rail becomes a fixed drawer with a scrim and the
  shell exposes a sticky mobile bar.

### Status Strip (signature)

The project workspace header: one dense band on panel ground carrying the
project title (17px), a mono metadata line with the live state word, the
environment/details controls, and the primary action right-aligned and always
visible. It is welded to the section rail beneath it — shared border, squared
adjoining corners — and both stick to the top of the viewport while the board
scrolls under them.

### State Row (signature)

A health row is: a 3px left edge in its state's hue, a ground tint for warn and
bad, the subject name at weight 550, a mono detail line beneath it, the mono
state word in a fixed 96px right-aligned column, and a mono value column at
72px. `state-working` pulses its edge between accent and 35% accent over 2.4s;
the animation is removed under `prefers-reduced-motion`. Table rows and feed
items take the same left-edge grammar so the rule survives across the console.

### Gauge Strip (signature)

`.stat-grid` is one bordered face, not a row of cards: cells auto-fit at 150px,
divided by hairlines, each with a mono uppercase key (10.5px) and a tabular
value (20px, weight 600, -0.02em). Hover tints the cell's ground; nothing moves.
Under 720px the dividers turn horizontal and the strip stacks.

### Motion

Short and functional. State transitions run 0.1–0.16s ease on colour, border and
background; meter fills run 0.4s; overlays enter with a 0.14–0.16s fade or a
small rise-and-settle; pages enter with a 4px rise over 0.18s. Only two things
loop: the provisioning dot/step pulse (1.4–1.6s opacity) and the working-row
edge pulse (2.4s). A global `prefers-reduced-motion` block reduces every
animation and transition to 0.01ms, and the working-row edge is stopped outright.

## Do's and Don'ts

### Do:

- **Do** put state on the region: a 3px left edge in the state's hue plus the
  warn/bad ground tint, paired with the mono state word.
- **Do** keep blue for action and identity — primary buttons, links, focus,
  current tab, in-progress.
- **Do** set every backend-read value in mono with tabular figures.
- **Do** give a panel a channel-label header band when it reports a channel, and
  let it bleed to the panel's edges.
- **Do** build readout groups as one bordered face divided by hairlines.
- **Do** add new tokens to `:root` and `[data-theme='light']` in the same pass,
  and measure both scenes for AA.
- **Do** stay on the 4px grid and on the 4px/3px/6px radius set.
- **Do** show real state only — an unknown value renders as an em dash or a
  muted state, never as a plausible placeholder.

### Don't:

- **Don't** give a resting surface a shadow; hairline and tonal step are the
  depth system.
- **Don't** use `accent` to mean healthy, degraded or failed.
- **Don't** set text in a status hue's pure value on that hue's soft surface;
  use the `*-ink` token.
- **Don't** put uppercase letterspaced type above a heading as a kicker or
  eyebrow — uppercase belongs to panel chrome that names a channel.
- **Don't** let a coloured dot or edge be the only carrier of a state; the state
  word ships with it.
- **Don't** float panels on grey with large radii and equal weight — that is the
  arrangement this console was built against.
- **Don't** introduce a third font, a display serif, or type above 20px outside
  the single posture score.
- **Don't** add inline `<style>` or `<script>`, or load a font or script from a
  third-party origin: the CSP is nonce-based and `self`-bound.
