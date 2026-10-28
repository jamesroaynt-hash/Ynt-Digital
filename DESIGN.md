---
name: YNT ERP
description: The in-house operations dashboard for YNT Digital Marketing.
colors:
  ink-navy: "#0f172a"
  ink-navy-light: "#1e293b"
  action-blue: "#3b82f6"
  action-blue-deep: "#2563eb"
  action-blue-wash: "#eff6ff"
  sidebar-night: "#0c1a2e"
  sidebar-night-raised: "#112240"
  flyout-night: "#16283f"
  ledger-gold: "#d4a843"
  sheet-white: "#ffffff"
  paper-mist: "#f8fafc"
  paper-shade: "#f1f5f9"
  rule-line: "#e2e8f0"
  rule-line-strong: "#cbd5e1"
  text-ink: "#0f172a"
  text-slate: "#475569"
  text-faint: "#94a3b8"
  delivered-green: "#10b981"
  pending-amber: "#f59e0b"
  returned-red: "#ef4444"
  dark-sheet: "#0f172a"
  dark-paper: "#0b1220"
  dark-shade: "#1e293b"
  dark-rule: "#1e293b"
  dark-text: "#f1f5f9"
  dark-action-blue: "#60a5fa"
typography:
  headline:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    letterSpacing: "-0.4px"
  stat:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "36px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  heading:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "20px"
    fontWeight: 600
  section:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  title:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  small:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "DM Sans, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.7px"
  mono:
    fontFamily: "DM Mono, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "16px"
  lg: "22px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.sheet-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.action-blue-deep}"
  button-secondary:
    backgroundColor: "{colors.paper-mist}"
    textColor: "{colors.text-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-slate}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.text-ink}"
    rounded: "{rounded.md}"
    padding: "9px 13px"
  card:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.xl}"
  stat-card:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.xl}"
    padding: "20px"
  badge:
    rounded: "{rounded.pill}"
    padding: "3px 9px"
    typography: "{typography.label}"
  nav-item:
    textColor: "{colors.sheet-white}"
    padding: "11px 20px"
  nav-item-active:
    backgroundColor: "rgba(59,130,246,0.15)"
    textColor: "{colors.sheet-white}"
  sidebar:
    backgroundColor: "{colors.sidebar-night}"
    width: "256px"
---

# Design System: YNT ERP

## Overview

**Creative North Star: "The Night Shift Ledger"**

YNT ERP is a calm, exact ledger that a whole business works from all day. A fixed navy sidebar frames the work like the cover of an account book; inside it, white sheets (cards) hold the numbers in tidy rows. The sky behind the sheets changes with the theme: a warm daylight wash in the top-right in light mode, an animated starfield in dark mode. That atmosphere is the only decoration the system allows, and it always sits behind the work, never on it.

Density is high and deliberate. Staff confirm orders, read RTS rates and check payroll at speed, on desktops and phones, so type is small but steady (13–14px body, 11.5px uppercase labels), numbers line up in tabular figures, and colour is spent on meaning: blue means "you can act here", green/amber/red mean an outcome. The look is kept, not reinvented: refinements stay inside this world, and a page is only redesigned when the owner asks for that page.

**Key Characteristics:**
- Navy sidebar frame, white sheets, one blue action colour.
- Status colours carry order outcomes (delivered, pending, returned), never decoration.
- Soft-lifted cards with 16px corners, styled after the Evaluation Result page.
- DM Sans throughout; DM Mono only for clocks, codes and scan fields.
- Two full themes (light and dark) with a living sky behind each.

## Colors

A cool slate-and-navy ledger with a single blue for action and a traffic-light set for outcomes.

### Primary
- **Action Blue** (#3b82f6; deepens to #2563eb on hover, #60a5fa in dark mode): primary buttons, links, focus rings, the active nav item's left rule and wash. Nothing else.
- **Action Blue Wash** (#eff6ff): the soft fill behind an active or selected item.

### Secondary
- **Sidebar Night** (#0c1a2e, raised #112240, flyouts #16283f): the sidebar frame and its collapsed-rail flyouts. Nav text sits on it at 55% white, 90% on hover, full white when active.
- **Ledger Gold** (#d4a843): rare honours only: certificates, seals, the super-admin touch.

### Tertiary
- **Delivered Green** (#10b981), **Pending Amber** (#f59e0b), **Returned Red** (#ef4444): order and task outcomes in badges, alerts and stat accents, each with a soft wash and a dark text partner (e.g. #ecfdf5 / #065f46). For chart series use the validated money pair #059669 / #ef4444, not these tokens.

### Chart Colors
Every chart takes its colours from one place (`ORDER_STATUS_COLORS`, `orderStatusColor()` and `mktChartColors()` in `app.js`), so a status or a money series looks the same on every tab.
- **Order status:** New #60a5fa, Confirmed #64748b, Waiting for pickup #f59e0b, Shipped #3b82f6, Delivered #059669, Returning #fbbf24, Returned #ef4444, Canceled #94a3b8. Same families as the status badges. Adjacent statuses pass the palette validator in both themes; every status chart keeps a legend.
- **Money:** money in (sales, COD, stock in) #059669, money out (ad spend, expenses, stock out) #ef4444.
- **Two non-money series:** blue #2a78d6 / orange #eb6834 (light), #3987e5 / #d95926 (dark).
- **Axes:** grid and tick colours come from the theme (`applyChartTheme()`), and a theme toggle repaints charts already on screen.

### Neutral
- **Sheet White** (#ffffff): cards, tables, inputs, the topbar.
- **Paper Mist** (#f8fafc) and **Paper Shade** (#f1f5f9): page background, table headers, hover rows, secondary buttons.
- **Rule Line** (#e2e8f0, strong #cbd5e1): every border and divider; strong is for input strokes.
- **Text Ink** (#0f172a), **Text Slate** (#475569), **Text Faint** (#94a3b8): primary, secondary and muted text.
- **Dark theme** swaps to Dark Sheet (#0f172a), Dark Paper (#0b1220), Dark Shade/Rule (#1e293b) and Dark Text (#f1f5f9); status washes become 14% tints.

### Named Rules
**The One Blue Rule.** Action Blue marks what can be clicked or what is active, and nothing else. Headers and highlights do not borrow it; charts use their own chart colours below.

**The Outcome Rule.** Green, amber and red always mean an outcome (delivered, waiting, returned/failed). Never use them for decoration or category colour.

## Typography

**Display Font:** DM Sans (with -apple-system, sans-serif)
**Body Font:** DM Sans
**Label/Mono Font:** DM Mono, for clocks, codes and scan inputs only

**Character:** One geometric, friendly sans at small, steady sizes; weight (500–600) and case do the hierarchy work, not size jumps.

### Hierarchy
- **Headline** (600, 22px, -0.4px tracking): page titles in the page header; 20px on phones.
- **Stat** (800, 36px, line-height 1, -0.02em, tabular figures): KPI and stat values; one line, never wraps; 26–36px with the tile width, 24–30px on phones.
- **Heading** (600, 20px): sub-headings inside a page.
- **Section** (600, 16px): section and modal titles.
- **Title** (600, 14px): card titles; inputs and nav items also sit at 14px.
- **Body** (400, 13px, line-height 1.6): table cells, buttons, form text, paragraphs.
- **Small** (400, 12px): meta lines, helper text, small buttons.
- **Label** (700, 11px, 0.08em tracking, uppercase): table headers; badges use the same size at weight 500.
- **Tile label** (500, 13px, sentence case, Text Slate): the label above every KPI figure.

### Named Rules
**The Eight Steps Rule.** Every font size is one of the eight steps, written as its token: `--fs-caption` 11px, `--fs-small` 12px, `--fs-body` 13px, `--fs-base` 14px, `--fs-title` 16px, `--fs-heading` 20px, `--fs-page` 22px, `--fs-figure` 26px. Only hero numbers of 32px and up (clocks, scores) and the standalone print documents (payslip, payroll sheet, certificate) sit outside it.

**The Steady Figures Rule.** Every number that can be compared (money, counts, rates) uses tabular figures and stays on one line.

**The 16px Field Rule.** On phones and touch screens every input, select and textarea is 16px, so iOS never zooms the page.

## Layout

A fixed 256px sidebar (collapsible to a 68px icon rail) plus a sticky 60px topbar frame a scrolling content column. Content uses cards in auto-fit grids; stat rows sit on top, tables and charts below. Every KPI tile row uses the same rule on desktop: auto-fit columns of at least 220px (`--tile-min`) with a 16px gap (`--tile-gap`), and every tile the same 20px padding (`--tile-pad`), so a figure like ₱1,253,480 always fits on one line. Rows never hard-code a column count. Page padding is 28px on desktop, 16px under 768px.

Breakpoints: 980px (login stacks), 768px (sidebar becomes an off-canvas drawer behind a hamburger, side-by-side grids stack, stats go two-up), 640px (list tables become one card per row with column labels; matrices and calendars keep horizontal scroll), 480px (stats go single-column). Phone overrides belong at the end of the stylesheet so later base rules cannot undo them.

## Elevation & Depth

Layered. Sheets lift softly off the sky: cards, stat cards and table containers carry the small ambient shadow at rest, and stat cards take the medium one on hover; menus, flyouts and modals take the large one. Shadows are neutral black at low opacity in light mode and deeper (30–55%) in dark mode, where the starfield needs the separation.

### Shadow Vocabulary
- **Resting sheet** (`box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)`): cards, stat cards, tables at rest.
- **Lifted sheet** (`box-shadow: 0 4px 12px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.04)`): hover on cards and stat cards.
- **Floating layer** (`box-shadow: 0 10px 30px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05)`): dropdowns, flyouts, the open mobile sidebar, modals.

### Named Rules
**The Soft Lift Rule.** Cards are lifted at rest with the resting shadow plus their 1px rule line; they never use a coloured or glowing shadow. A sheet inside another sheet stays flat, and only stat cards lift further on hover.

## Shapes

Gently curved, never sharp, never bubbly. Buttons and inputs take 8px corners, toolbar search and select controls 12px, cards, panels, tables and modals 16px, and badges, chips and toggles are full pills (999px). Every surface is bounded by a 1px rule line; clipping (`overflow: hidden`) keeps table corners following the card's curve.

## Components

### Buttons
Compact and confident: small type, firm colour, no ornaments.
- **Shape:** gently curved (8px).
- **Primary:** Action Blue fill, white text, 8px 16px padding, 13.5px weight 500.
- **Hover / Focus:** fill deepens to #2563eb over 0.18s; focus shows the blue ring. Disabled drops to 50% opacity.
- **Secondary / Ghost / Danger / Success:** Paper Mist fill with ink text; transparent with slate text; red wash with red text; solid green. Small (6px 12px, 12.5px) and large (11px 22px, 14.5px) sizes exist.
- **Touch:** at least 44px tall on coarse pointers; mouse users keep the compact height.

### Chips / Badges
- **Style:** full pill (999px), 3px 9px, 11.5px weight 500, status wash fill with its dark text partner.
- **State:** colour always maps to an outcome; neutral badges use Paper Shade with slate text.

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** Sheet White (Dark Sheet in dark mode).
- **Shadow Strategy:** resting sheet at rest, lifted sheet on hover (see Elevation & Depth).
- **Border:** 1px Rule Line.
- **Internal Padding:** header 18px 20px with a rule beneath (16px bold title, 13px subtitle); body 20px; 16px on phones.

### Inputs / Fields
- **Style:** Sheet White fill, 1px Rule Line Strong stroke, 8px corners, 9px 13px padding, 14px text (16px on phones and touch).
- **Focus:** stroke turns Action Blue with a 3px 10%-blue halo.
- **Placeholder:** Text Faint.

### Navigation
- **Sidebar:** Sidebar Night, 15px items at 55% white with 18px icons at 75% opacity. Hover lifts to 90% white on a 5% white wash; active is full white on a 15% blue wash with a 2px Action Blue left rule. Collapses to a 68px icon rail with flyouts; under 768px it becomes an off-canvas drawer.
- **Topbar:** sticky, 60px, Sheet White with a bottom rule; breadcrumb on the left.

### Stat Card (signature)
The ledger's headline figure, modelled on the Evaluation Result cards: Sheet White, 16px corners, 20px padding, a 13px sentence-case label in Text Slate, one 36px weight-800 tabular figure in ink, and a muted 12px meta line beneath. No coloured edge: a tile shows meaning through its label, its meta line, a progress bar where one fits, or a status badge. Every KPI tile on every tab (stat cards, RTS metrics, ERP KPIs, expense tiles, Ads Manager KPIs, ad-spend metrics) follows it.

**The Evaluation Result Rule.** The Evaluation Result page is the reference for every page: page title 26px weight 800 over a 14px lede; panels with an 18px 20px header, a 16px bold title and a 13px subtitle; table heads 11px bold uppercase with 0.08em tracking over 14px rows padded 10px 20px; filter pills 36px tall that fill with ink when active; toolbar search and selects 42px tall with 12px corners. When a page and Evaluation Result disagree, Evaluation Result wins.

### Data Table (signature)
Uppercase 11.5px headers on Paper Mist, 13.5px cells with 13px 16px padding, row rules, hover rows in Paper Mist. Under 640px each row becomes its own card with the column name beside each value.

## Do's and Don'ts

### Do:
- **Do** use Action Blue (#3b82f6) only for buttons, links, focus and the active nav item.
- **Do** keep every comparable number in tabular figures on one line.
- **Do** give cards the resting shadow plus a 1px #e2e8f0 rule line and 16px corners.
- **Do** design both themes for every new surface; use the tokens, never hard-coded light colours.
- **Do** make phone layouts real: 16px fields, 44px touch targets, tables as cards under 640px.
- **Do** keep the sky (daylight wash, starfield) behind the work only.

### Don't:
- **Don't** use green, amber or red for anything but outcomes, and don't use the --success/--danger tokens as chart series colours (use #059669 / #ef4444).
- **Don't** add new decoration (gradient blobs, glows, gradient text, illustrated icon tiles) on top of the sheets.
- **Don't** introduce a second typeface; DM Mono stays limited to clocks, codes and scan fields.
- **Don't** replace the navy sidebar, the two themes or the starfield during a refinement.
