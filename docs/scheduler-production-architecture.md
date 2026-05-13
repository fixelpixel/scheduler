# Scheduler Production Architecture

Last updated: 2026-05-13

## Current-State Audit

This iteration is on branch `codex/scheduler-production-iteration`. The worktree already had unrelated local changes before this work started, so do not use broad reset/checkout commands. Review only the files in the implementation scope before committing.

Core app files:
- `app/routes/app.collections.tsx` - merchant collection scheduling editor.
- `app/routes/app.settings.tsx` - publication and metafield definition setup.
- `app/routes/app._index.tsx` - dashboard health and definition bootstrap.
- `app/jobs/run-schedule-job.server.ts` - per-shop/all-shop scheduler execution.
- `app/services/collection-scheduler.server.ts` - Admin GraphQL reads and managed product status updates.
- `app/services/scheduler-engine.server.ts` - pure date evaluation.
- `app/services/schedule-contract.ts` - shared mode/key normalization contract.
- `app/services/storefront-schedule.server.ts` and `app/routes/api.storefront-schedule.tsx` - public storefront notice API.
- `app/services/checkout-schedule.server.ts` and `app/routes/api.checkout-schedule.tsx` - public-safe checkout notice API.

Extension files:
- `extensions/storefront-countdown/blocks/scheduler-countdown.liquid`
- `extensions/storefront-countdown/assets/scheduler-countdown.js`
- `extensions/storefront-countdown/assets/scheduler-countdown.css`
- `extensions/checkout-schedule/shopify.extension.toml`
- `extensions/checkout-schedule/src/index.tsx`
- `extensions/checkout-schedule/src/CheckoutSchedule.tsx`
- `extensions/checkout-schedule/src/shopify-ui-elements.d.ts`
- `extensions/checkout-schedule/locales/en.default.json`

Verification files:
- `scripts/verify-schedule-contract.mjs`
- `scripts/verify-checkout-schedule.mjs`
- `tsconfig.checkout-extension.json`

Known risks:
- Checkout UI extensions on the information, shipping, and payment steps require Shopify Plus. Do not promise checkout display to a non-Plus client.
- Checkout calls are necessarily public network calls from Shopify checkout. They must remain minimal, fail closed, avoid cart/customer logging, and use bounded request bodies.
- Storefront and checkout display modes are not availability modes. They must never cause product publish/unpublish.
- Legacy `schedule.display_mode` remains read-compatible but must not control product publication.
- Do not bulk rewrite existing metafields without explicit approval.

## Information Architecture

The merchant-facing model should use one collection detail modal from the collection table, not a separate detail page yet. The current merchant workflow is list -> edit one collection -> save/reload, and the surface area is still small enough for one modal. A bulk table is useful later for operational edits, but it is too easy to misuse while modes are being separated.

Recommended admin sections:
- Availability automation: controls whether the scheduler changes product status. Options: `managed`, `always_live`, `none`.
- Schedule dates: `start_date` and `end_date`. In `managed`, both are required. In `always_live`, dates are reporting/display inputs only. In `none`, dates are optional but should not drive automation.
- Storefront notice: controls product/collection page messaging. Options: `none`, `countdown_to_end`, `message`.
- Checkout notice: Shopify Plus-only display. Options: `inherit_storefront`, `none`, `countdown_to_end`, `message`.
- Visual style: notice variant and lightweight labels/colors in the theme extension.

Copy rules:
- Say "Managed availability changes product status between ACTIVE and DRAFT for products in the collection."
- Say "Always live keeps products available. Dates can still power countdowns, checkout copy, and reports."
- Say "No automation means the scheduler skips this collection."
- Say "Storefront notices only affect theme display."
- Say "Checkout notices require Shopify Plus checkout extensibility and render only where Shopify allows checkout UI extensions."

Validation rules:
- `availability_mode=managed` requires valid `start_date` and `end_date`, with end after start.
- `availability_mode=always_live` accepts dates but does not require them unless a countdown display needs `end_date`.
- `availability_mode=none` should not require dates.
- `storefront_mode=countdown_to_end` requires `end_date`.
- `storefront_mode=message` requires `custom_message`.
- `checkout_mode=inherit_storefront` inherits storefront validation.
- `checkout_mode=countdown_to_end` requires `end_date`.
- `checkout_mode=message` requires `checkout_message`, or inherited `custom_message` when using inheritance.

Legacy rules:
- `display_mode=countdown` maps to `storefront_mode=countdown_to_end`.
- `display_mode=message` maps to `storefront_mode=message`.
- `display_mode=none` maps to `storefront_mode=none`.
- Legacy values can be silently normalized for reads and newly saved records can write the new fields. Do not bulk migrate old metafields yet.

## Storefront UX

Collection pages should render the notice above the collection grid, scoped to the current collection handle.

Product pages with collection context should prefer the collection from the URL/context when available. Direct product pages should resolve the first relevant collection schedule returned by the storefront resolver and fail closed when no scheduled collection applies.

Supported variants:
- `theme_native`: minimal theme-friendly block with inherited typography.
- `inline_product_form`: compact block before the product form.
- `collection_bar`: full-width collection page bar.
- `compact_banner`: smaller banner suitable above forms or grids.

Merchant controls:
- Countdown label.
- Default variant.
- Background, text, and accent colors at the theme block level.
- Expired behavior: hide by default; optionally show expired copy later if approved.
- Mobile layout should stack label and timer without overlapping product forms or collection grids.

Hardcoded:
- API response schema.
- Safe fallback mode `none`.
- No-store cache headers.
- Accessibility basics such as `aria-live`.

Configurable:
- Visual variant.
- Label.
- Basic colors.
- Storefront custom message.

## Checkout UX

Checkout display uses a checkout UI extension at `purchase.checkout.block.render`, configured by the merchant in checkout editor where available.

Plan requirement:
- Shopify documentation currently states checkout UI extensions for information, shipping, and payment steps are Shopify Plus-only. Confirm the client store plan before acceptance testing checkout.

Fallback for non-Plus:
- Keep storefront product/collection notices active.
- Keep Essential Countdown Timer or equivalent disabled only after storefront acceptance, not before.
- Do not add checkout promises to the merchant review checklist until Plus access is confirmed.

Recommended placement:
- Primary: merchant-inserted block after line items/order summary if available in the checkout editor.
- Secondary: before shipping methods if the merchant wants timing pressure before delivery decisions.
- Avoid blocking progress; this is informational only.

Selection logic:
- Extension reads cart line product and variant GIDs from Shopify checkout APIs.
- Extension POSTs only IDs and shop domain to `/api/checkout-schedule`.
- Server resolves product -> collections with Admin GraphQL.
- Message wins over countdown.
- For active countdowns, pick the earliest end date.
- For upcoming countdowns, pick the nearest start date.
- Invalid/expired/missing data returns `mode=none`.

Privacy rules:
- Do not log cart line IDs, product IDs, variant IDs, checkout token, buyer identity, customer info, shipping address, or raw request body.
- API response must contain only `mode`, `endDate`, `message`, and `serverTime`.
- Request body is size-limited and arrays are capped before iteration.
- The app route includes a basic in-process rate limit. Production should still use the reverse proxy or host firewall for durable edge rate limiting.

## Data Contract

Namespace:
- Default: `schedule`
- Shop-configured namespace still applies for date fields where already supported.

Metafields:
- `schedule.start_date`: existing date/date_time input.
- `schedule.end_date`: existing date/date_time input.
- `schedule.availability_mode`: `managed | always_live | none`.
- `schedule.storefront_mode`: `none | countdown_to_end | message`.
- `schedule.custom_message`: storefront message text.
- `schedule.checkout_mode`: `inherit_storefront | none | countdown_to_end | message`.
- `schedule.checkout_message`: checkout-specific message text.
- `schedule.notice_variant`: `theme_native | inline_product_form | collection_bar | compact_banner`.
- `schedule.notice_settings`: JSON for future display settings; keep optional and fallback-safe.
- `schedule.display_mode`: legacy read-only compatibility input.

Storefront API response:
```json
{
  "mode": "none | countdown_to_end | message",
  "endDate": "2026-05-20T00:00:00.000Z | null",
  "customMessage": "string | null",
  "collectionHandle": "string | null",
  "collectionTitle": "string | null",
  "serverTime": "2026-05-13T12:00:00.000Z",
  "noticeVariant": "theme_native | inline_product_form | collection_bar | compact_banner",
  "label": "string | null",
  "expiredBehavior": "hide | show_expired_message"
}
```

Checkout API request:
```json
{
  "productIds": ["gid://shopify/Product/123"],
  "variantIds": ["gid://shopify/ProductVariant/456"]
}
```

Checkout API response:
```json
{
  "mode": "none | countdown_to_end | message",
  "endDate": "2026-05-20T00:00:00.000Z | null",
  "message": "string | null",
  "serverTime": "2026-05-13T12:00:00.000Z"
}
```

## Implementation Phases

1. Shared contract: centralize keys, modes, normalization, and legacy mapping.
2. Admin UX: add explicit availability/storefront/checkout sections and validation.
3. Storefront UX: add variants, block settings, and safe API defaults.
4. Checkout API: resolve line item products to collection schedules with minimal public output.
5. Checkout extension: scaffold Plus-gated block with HTTPS-only app URL and POST body.
6. Production hardening: remove debug dumps, add product pagination/error propagation, write QA/deployment docs, and verify.
