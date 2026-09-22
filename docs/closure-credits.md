# Gym closure credits

The manager app has a **Closure Credits** entry under **Reports & Billing**. Use it after normal gym access resumes. Enter the first closed day, actual reopening date, and reason. The reopening day is excluded.

Creating or refreshing a preview only saves review data. It does not change Stripe balances. Review each account and the total, exclude accounts already compensated (with a reason), acknowledge prior refunds/credits, then confirm **Apply credits**. Applying creates a USD Stripe customer invoice balance credit once per account. It reduces that customer's next finalized invoice, including a rental or other invoice if it comes before the membership renewal; excess credit carries forward. It does not refund a card or change renewal dates.

Only the configured Weight Room, Full Facility, and Full Facility + Wi-Fi subscription prices qualify. The amount comes from paid invoice lines after discounts, prorated by closed calendar days within each billing period, using America/Los_Angeles. Open Gym, one-time fees, rentals, utilities, and free membership charges are not credited. Family accounts receive one adjustment per account, not per person.

Refunds, disputes, credit notes, unpaid invoices, prorations, overlapping paid subscription periods, unsupported recurring prices, canceled memberships, and missing customer links require review. Automatic credit is blocked for the whole affected account until it is excluded or its draft preview is refreshed after resolving the issue. Manual/offline compensation cannot be inferred reliably: review it before acknowledging. A draft snapshots account-to-customer mappings; cancel an unused draft and recreate it after repairing a missing/wrong link. Excluded accounts must be resolved separately.

Dates cannot overlap another non-canceled closure. Cancel an unused draft to correct its dates. Once approved, the preview is locked. Reload the saved closure and use **Resume remaining credits** after an interrupted apply. A processing account has a two-minute retry lock. The API recovers existing Stripe transactions by adjustment metadata even beyond Stripe's idempotency retention window. Never delete the local adjustment records to retry.

## Setup

Apply `supabase/migrations/*_facility_closure_credits.sql` before deploying the app. The tables use RLS with no anonymous or authenticated grants. Only the server's service role can access them; every API action separately verifies a Supabase user with the `Account Manager` account type. There is no automatic scheduler or credit issuance at deployment.

The feature reuses existing environment variables:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_WEIGHT_ROOM_MONTHLY`
- `STRIPE_PRICE_FULL_FACILITY_MONTHLY`
- `STRIPE_PRICE_FULL_FACILITY_WIFI_MONTHLY`
- `STRIPE_PRICE_OPEN_GYM_MONTHLY` to identify the excluded Open Gym subscription

`npm run vercel-build` compiles the TypeScript API through the existing server build and creates `RORC App/closure-credits.js` from its TypeScript source. The small CommonJS API wrapper follows the repository's existing deployment pattern. Existing navigation remains in `app.js` for compatibility.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run vercel-build`. Focused tests cover billing-period boundaries, discounts, DST, eligibility, refunds, paging failures, duplicate recovery, and authorization.

The standalone database verification uses PGlite installed outside the project, with no new production dependency:

```sh
npm install --prefix /tmp/rorc-db-check --no-audit --no-fund @electric-sql/pglite
NODE_PATH=/tmp/rorc-db-check/node_modules node scripts/verify-closure-credits-db.cjs
```

It tests the actual SQL migration against isolated fixture accounts, including overlap protection, stale-preview rejection, claim/retry transitions, completion, and anonymous/member access restrictions. Local browser verification should use simulated Stripe; issuing live credits is a separate manager action after reopening.
