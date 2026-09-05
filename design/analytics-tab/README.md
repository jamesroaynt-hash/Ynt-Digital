# Data Report → Analytics tab redesign

Source artboards for the design canvas at
https://claude.ai/code/artifact/87925fa7-c054-450d-ba71-c27a68450272

- `Current.dc.html` — the Analytics tab as it ships today (default "By Price" view)
- `Main.dc.html` — the restructured tab: totals band, price as a 0–20% column
  chart, staff/page/province as ranked cards, old sub-tab pills demoted to a
  detail-table switcher
- `canvas.json` — artboard layout, sizes and the sticky notes on the canvas

Both artboards are drawn in the app's dark tokens (`main.css` `[data-theme="dark"]`)
at the real content width (1184px = 1440 window − 256px sidebar). Numbers are real
August 2026 figures pulled from `pos_orders`, not sample data.

These are mockups — nothing here is loaded by the app. To change the published
canvas, edit these files and re-seed with the `/design` skill rather than editing
the artifact's HTML.
