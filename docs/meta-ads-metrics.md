# Meta Ads — Metric Definitions

Every number on the Ads Manager page, in the CSV exports and in the MCP tools comes
from one of **two sources**. They are never blended into one figure.

| Source | Table | What it is |
|---|---|---|
| **Meta** | `meta_insights_daily` | What Meta's Marketing API reports, one row per ad per reporting day (the ad account's timezone). Default attribution window (7-day click / 1-day view). |
| **YNTERP actuals** | `pos_orders` joined to `meta_ads` on `pos_orders.ad_id = meta_ads.meta_ad_id` | Pancake POS orders whose stored Facebook ad id matches a synced ad. Day = the Manila business day the order was placed (same rule as the Data Report). Canceled / removed orders are excluded. |

All ratios are recomputed from **summed counters** over the selected range — never
averaged across rows. The formulas live once in SQL (`DERIVED_SQL`) and once in JS
(`derive()`) in `backend/services/metaAdsReports.js`; a test checks they agree.

## Meta-reported

| Metric | Definition |
|---|---|
| Amount Spent / Ad Spend | `SUM(spend)` |
| Impressions | `SUM(impressions)` |
| Reach | `SUM(reach)` of daily rows. **Not unique across days** — Meta's unique reach for a range needs a separate range query. |
| Clicks | `SUM(clicks)` (all clicks) |
| Link Clicks | `SUM(inline_link_clicks)` |
| CTR | `clicks ÷ impressions × 100` |
| CPC | `spend ÷ clicks` |
| CPM | `spend ÷ impressions × 1000` |
| Frequency | `impressions ÷ reach` (inherits the reach caveat) |
| Messages | Messaging conversations started (`onsite_conversion.messaging_conversation_started_7d`) |
| Cost / Msg | `spend ÷ messages` |
| Meta Purchases | First present action type of `omni_purchase` → `purchase` → `offsite_conversion.fb_pixel_purchase` → `onsite_web_purchase`. Taking the first (not the sum) avoids double counting, because `omni_purchase` already includes the others. |
| Meta Revenue | Same priority over `action_values` |
| Meta ROAS | `Meta Revenue ÷ spend` |
| CPA | `spend ÷ Meta Purchases` |
| Leads | First present of `lead` → `onsite_conversion.lead_grouped` → `offsite_conversion.fb_pixel_lead` |

`actions_json` keeps the raw purchase / lead / message / link-click action entries per
row so these can be re-derived without re-syncing.

## YNTERP actuals (attributed POS orders)

Statuses use `effectivePosStatusSql()` — an undeliverable order past the 60-day
abandonment cutoff counts as **returned**, exactly as in the Data Report.

| Metric | Definition |
|---|---|
| POS Orders | `COUNT(*)` of attributed orders |
| Gross COD | `SUM(cod)` of those orders |
| Delivered | orders with effective status `delivered` |
| Returned | `returned` + `returning` |
| Delivered COD | `SUM(cod)` where delivered |
| Returned COD | `SUM(cod)` where returned or returning |
| RTS % | `(returned + returning) ÷ (delivered + returned + returning) × 100` — settled orders only; new / confirmed / shipped have no verdict yet |
| Delivery rate | `delivered ÷ (delivered + returned + returning) × 100` |
| Cost / Order | `spend ÷ POS Orders` |
| Cost / Delivered | `spend ÷ Delivered` |
| **Actual ROAS** | `Delivered COD ÷ spend` |
| COD − Spend | `Delivered COD − spend`. **Not net profit**: product cost and shipping cost are not tracked per order yet. |

## Flags

Thresholds come from `meta_targets` — most specific scope wins per field:
campaign → page → ad account → organization.

**Needs attention** when the row has spend and any of these hold:
- Actual ROAS below `target_actual_roas` *(only once ≥ 50% of its orders are settled)*
- Meta ROAS below `target_roas` *(only when Meta reports purchases)*
- Cost per order above `max_cpa`, or spend ≥ `max_cpa` with zero orders and zero purchases
- CPM above `max_cpm`
- CTR below `min_ctr` *(only with ≥ 1,000 impressions)*
- RTS above `max_rts` *(only once ≥ 50% settled)*

**Winning** when nothing above fires and Actual ROAS ≥ `target_actual_roas`
(or Meta ROAS ≥ `target_roas`).

The 50%-settled guard exists because recent orders are still in transit: without it
every new campaign would read as losing money.

## Known accuracy limits

- **Timezone:** Meta days are the ad account's timezone; POS days are Manila. They
  line up for `Asia/Manila` accounts. The account's timezone is shown in Connections.
- **Attribution coverage:** only POS orders where Pancake captured the Facebook `ad_id`
  are attributed (about two-thirds of orders as of 2026-09-15). Orders without one are
  not in any Meta Ads figure.
- **Lag:** the sync refreshes the last 3 days each run, because Meta keeps revising
  recent days. Older days only change on a reconciliation ("Reconcile 90 days").
