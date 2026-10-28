# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Internal staff of YNT Digital Marketing, a Philippine cash-on-delivery (COD) e-commerce business selling through Facebook pages. Every role uses it daily:

- **CSR / order confirmers:** confirm Pancake POS orders, follow up returns and failed deliveries (RMO), check their own confirmed orders (CSR Records).
- **Marketing / ad buyers:** ad spend and ROAS per page, Meta Ads Manager, creatives.
- **HR / Operations:** attendance, payroll, evaluations, employee tracker, stock and supplier flow.
- **Owner / super admin:** Daily Summary, Data Report, approvals, user management, overall numbers.

Used on both office desktops and phones; real work happens on each, so phone layouts are first-class, not a fallback.

## Product Purpose

One in-house ERP (branded "YNT ERP") that replaces spreadsheets: orders, courier outcomes, ad spend, inventory, attendance and payroll live in one place, computed from synced data instead of rebuilt by hand. Success means staff trust the numbers on screen and act on them without exporting to a sheet.

## Positioning

It joins sources no off-the-shelf tool joins for this business: Pancake POS orders (per shop/page), courier delivery and return status, Meta ad spend per Facebook page, and staff attendance → payroll. Metrics like RTS rate and ROAS are computed from those joined records.

## Operating Context

- Money is Philippine pesos (₱); dates and "today" are Manila time (UTC+8).
- Orders sync from Pancake POS; ad spend from Meta; some data from Google Sheets.
- Key business terms: COD, RTS (return to sender), RMO, delivered/returning/returned, page (a Facebook selling page), confirmer, ROAS.
- Access is role-based; some pages are admin or super-admin only.
- Frontend is a vanilla JS single-page app (`frontend/`), deployed on a Cloudflare Worker at www.ynterp.work; backend is Node/Express on Railway.

## Capabilities and Constraints

- Existing codebase answers the stack: vanilla JS + one main stylesheet (`frontend/assets/css/main.css`), no framework or build step.
- Light and dark themes both ship.
- Data-dense tables are core; on phones, list tables become cards under 640px (`frontend/assets/js/phone-fit.js`); matrices keep horizontal scroll.
- UI language is English only.

## Brand Commitments

- Name: YNT ERP / YNT Digital Marketing.
- The current look is the default to keep: navy sidebar, light/dark themes, starfield background in dark mode. Refinements preserve it.
- The owner is open to redesigning specific surfaces when explicitly asked; a redesign request overrides the keep-the-look default for that surface only.

## Evidence on Hand

- Real operational data in the production database (orders, spend, attendance).
- No customer testimonials, external customers, or published benchmarks: this is an internal tool. Do not invent any.

## Product Principles

1. The numbers must be right and match across pages (one formula per metric, e.g. the canonical RTS rate).
2. Fit the daily task: scanability and speed over decoration.
3. Works on a phone as well as a desk.
4. Plain business terms the team already uses; no marketing language inside the app.
