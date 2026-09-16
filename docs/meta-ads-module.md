# Meta Ads Module (Ads Manager + MCP)

Sales & Marketing → **Ads Manager**. Visible to Administrator, Sales and Marketing,
Sales and Marketing TL.

```
Meta Marketing API ──sync──▶ meta_* tables ──▶ /api/meta/* ──▶ Ads Manager page
                                   ▲                  │
                         pos_orders (ad_id) ──────────┘──▶ MCP server (AI clients)
```

The dashboard never calls Meta on page load; it reads the synced tables.

## Files

| File | Purpose |
|---|---|
| `backend/db/metaAdsSchema.js` | Tables + indexes (SQLite and Postgres), run at boot from `db/init.js` |
| `backend/services/metaAds.js` | Token encryption, Graph API client (retry, rate limits, error classes), OAuth helpers, sync |
| `backend/services/metaAdsReports.js` | All aggregation SQL, flags, CSV |
| `backend/routes/metaAds.js` | `/api/meta/*` endpoints, access control, confirm-token actions |
| `backend/mcp/meta-ads-mcp.js` | Stdio MCP server (no dependencies) |
| `backend/tests/metaAds.test.js` | Tests (`npm run test:meta` in `backend/`) |
| `frontend/assets/js/ads-manager.js`, `frontend/assets/css/ads-manager.css` | The page |
| `docs/meta-ads-metrics.md` | Every metric's source and formula |

## Tables

`meta_connections` (encrypted token), `meta_ad_accounts`, `meta_pages`, `meta_campaigns`,
`meta_adsets`, `meta_ads`, `meta_insights_daily` (unique `ad_id, date`), `meta_sync_logs`,
`meta_action_logs`, `meta_targets`. Plus index `idx_pos_orders_ad_id`.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `META_API_VERSION` | no | `v24.0` | Graph API version |
| `META_APP_ID` | for Facebook login | — | Not needed when pasting a token |
| `META_APP_SECRET` | for Facebook login | — | Also enables `appsecret_proof` on every call and token-expiry lookup |
| `META_REDIRECT_URI` | for Facebook login | — | e.g. `http://localhost:3001/api/meta/oauth/callback` |
| `META_TOKEN_ENC_KEY` | recommended | derived from `JWT_SECRET` | 64 hex chars (`openssl rand -hex 32`). Without it, rotating `JWT_SECRET` forces every Meta connection to reconnect |
| `META_SYNC_ENABLED` | no | `false` | `true` = background sync of all connections |
| `META_SYNC_INTERVAL_MS` | no | `900000` (15 min) | Minimum 5 minutes |
| `META_BACKFILL_DAYS` | no | `30` | Insights history pulled on a new ad account's first sync (max 1095) |
| `META_REFRESH_DAYS` | no | `3` | Trailing days re-pulled on every sync |
| `META_MAX_DAILY_BUDGET` | no | `1000000` | Upper bound accepted by budget changes |

## Connecting

**Simplest (local testing): paste a token.** Ads Manager → Connections → Access token.
- Best: a **System User** token (Business Settings → Users → System users → Generate
  token) with `ads_read` (+ `ads_management` to pause/activate/change budget,
  `pages_show_list` for Page names). Assign the ad accounts to that system user.
- Or a long-lived user token from the Graph API Explorer (expires in ~60 days).

**Facebook login (OAuth):** set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`;
a "Continue with Facebook" button appears.

### Meta App configuration
1. developers.facebook.com → Create app → type **Business**.
2. Add products **Facebook Login for Business** and **Marketing API**.
3. Facebook Login → Settings → Valid OAuth Redirect URIs = your `META_REDIRECT_URI`.
4. Permissions requested: `ads_read`, `ads_management`, `pages_show_list`. In
   Development mode only app roles (admins/developers/testers) can log in — enough for
   local testing. Going live for other users needs App Review + Business Verification.

## Sync

| When | What |
|---|---|
| On connect | Ad accounts, Pages, campaigns, ad sets, ads, and `META_BACKFILL_DAYS` of daily insights |
| Every `META_SYNC_INTERVAL_MS` (if enabled) | Same hierarchy + the last `META_REFRESH_DAYS` days |
| Sync now | Same as interval, on demand |
| Reconcile 90 days | Re-pulls 90 days of insights (`POST /api/meta/sync {"days": 90}`) |

Unchanged rows are not rewritten (`IS DISTINCT FROM` upsert guard). Each step writes a
`meta_sync_logs` row. Rate limits retry with backoff; an expired token marks the
connection `expired` and the page shows "Reconnect Meta Account"; a missing Page
permission does not stop the ad sync. Untick an ad account in Connections to stop
syncing it.

## API (`/api/meta`, JWT or API key)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | Config, counts, freshness |
| GET / POST | `/connections` | POST `{name, access_token}` validates, stores encrypted, starts first sync |
| PATCH / DELETE | `/connections/:id` | PATCH `{name}` renames, `{enabled:false}` hides (status `disabled`: out of every report and out of the auto-sync, token and history kept). DELETE detaches the ad accounts, which hides them too; `?purge=1` also deletes their campaigns, ad sets, ads and daily insights (irreversible). |
| GET | any report | A report only shows ad accounts that are attached to a connection that is not `disabled` and whose own `enabled` tick is on. `include_detached=1` ignores all three and reads the full synced history. |
| PATCH | `/ad-accounts/:id` | `{enabled}` — the per-ad-account hide switch: off means no sync, no actions and no rows in any report, history kept. |
| — | field pruning | Meta rejects a whole request over one unknown field (code 100) and names it. `graphRequestPruning` drops that field and retries, so an API version dropping `adtrust_dsl` or `next_bill_date` cannot cost the fields that do work — a fixed narrower fallback silently lost the card. |
| GET | `/ads/:id/preview` | `?format=mobile\|desktop\|story\|reels\|instagram` → a short-lived iframe URL on facebook.com. Meta renders the creative; the browser streams it. Nothing is stored or proxied, so the URL is fetched per view and never cached. |
| GET | `/billing` | Per visible ad account: payment method, balance, spend cap, daily spend limit and account standing read live from Meta (never stored), plus today / month-to-date / range spend from the synced insights. It also returns `spend_by_month` (last 12 calendar months from the synced insights) and, best effort, `charges` — Meta's payment activity per transaction. **The `act_<id>/transactions` edge does not exist from v24** (probed live: "nonexisting field (transactions)"), and there is no replacement for card-paid accounts, so `charges` is normally empty with the reason in `charges_note`; the fallback reads `business_invoices`, which only covers accounts on a credit line. Transaction ids and VAT invoice PDFs are Meta-billing-hub only. When charges do come back, `charges_by_month` (what the card was actually charged: refunds netted off, declines and pending kept apart, and ad credit counted separately because it never touches the card). Meta gates the charge edge on some accounts — that comes back as `charges_note`, not an error. |
| GET | `/oauth/start` → Meta → `/oauth/callback` | Facebook login |
| POST | `/sync` | `{connection_id?, days?, ad_account_id?}` → 202, runs in background |
| GET | `/sync-logs` | |
| GET | `/summary`, `/trend` | Totals / daily series |
| GET | `/campaigns`, `/adsets`, `/ads`, `/pages`, `/accounts` | Filters: `from`, `to`, `ad_account_id`, `page_id`, `campaign_id`, `adset_id`, `ad_id` (comma lists), `status` (all/active/paused/with_spend), `search`, `min_spend`, `max_roas`, `min_roas`, `roas_basis` (actual/meta), `sort`, `dir`, `page`, `per_page`; `format=csv` exports up to 10,000 rows |
| GET | `/entity/:level/:id` | Row + record + daily trend |
| GET | `/profitability?group_by=page` | Totals + breakdown + notes |
| GET / PUT | `/targets` | `{scope_type, scope_id, target_actual_roas, target_roas, max_cpa, max_cpm, min_ctr, max_rts}` |
| POST | `/actions/preview` | `{action: pause/activate/update_budget, level: campaign/adset/ad, id, daily_budget?}` → preview + `confirm_token` (5 min) |
| POST | `/actions/execute` | `{confirm_token}` — same user/key only, single use; logged to `meta_action_logs` |
| GET | `/actions` | Action log |

API keys need scope `meta:read` (reads) or `meta:write` (actions) — Integrations → API Keys.

## MCP server

Create an API key with `meta:read` (add `meta:write` only if the AI may pause/activate/
change budgets), then register the server. Claude Code (project `.mcp.json`, keep the
key out of git — prefer your user-level config):

```json
{
  "mcpServers": {
    "ynterp-meta-ads": {
      "command": "node",
      "args": ["D:/SYSTEM/ynt-dashboard/backend/mcp/meta-ads-mcp.js"],
      "env": { "YNT_API_URL": "http://localhost:3001/api", "YNT_API_KEY": "yntk_..." }
    }
  }
}
```

Read tools: `get_meta_connections`, `get_sync_status`, `get_ad_accounts`, `get_pages`,
`get_campaigns`, `get_adsets`, `get_ads`, `get_campaign_insights`, `get_adset_insights`,
`get_ad_insights`, `get_page_performance`, `get_account_performance`, `get_top_campaigns`,
`get_top_ads`, `get_low_roas_campaigns`, `get_profitability`.

Management tools: `pause_campaign`, `activate_campaign`, `pause_adset`, `activate_adset`,
`pause_ad`, `activate_ad`, `update_campaign_budget`, `update_adset_budget`. A call
without `confirm_token` only returns an **ACTION REQUEST** preview; execution needs a
second call with the token after the user confirms. Keep per-call approval on for
these tools in your MCP client.

## Running locally

```bash
cd backend
npm run test:meta          # tests (in-memory SQLite, fake Meta API)
npm run dev                # then open http://localhost:3001 → Sales & Marketing → Ads Manager
```

Note: when `backend/.env` has `DATABASE_URL`, "local" runs against that Postgres
database — the `meta_*` tables are created there on boot (additive, nothing else
reads them).
