# Scheduler Production QA And Rollout

Last updated: 2026-05-13

## Required Verification Commands

Run before handoff:
```bash
npm run typecheck
npm run typecheck:checkout-extension
npm run verify:schedule-contract
npm run verify:checkout-schedule
npm run build
```

## QA Matrix

| Area | Case | Expected result |
|---|---|---|
| Admin save/reload | Save `availability_mode=managed` with valid start/end | Reload shows same mode/dates; scheduler can act on it |
| Admin save/reload | Save `availability_mode=always_live` with dates and countdown | Reload keeps products live semantics; storefront can display countdown |
| Admin save/reload | Save `availability_mode=none` | Scheduler skips collection |
| Admin validation | Managed mode without start or end | Save blocked with clear validation |
| Admin validation | Storefront countdown without end date | Save blocked |
| Admin validation | Storefront message without message text | Save blocked |
| Admin validation | Checkout countdown without end date | Save blocked |
| Admin validation | Checkout message with no checkout or inherited message | Save blocked |
| Legacy compatibility | Collection has only `display_mode=countdown` | Storefront resolves `countdown_to_end`; scheduler availability is not controlled by display mode |
| Scheduler behavior | Managed active window | Products in collection become ACTIVE |
| Scheduler behavior | Managed outside window | Products in collection become DRAFT |
| Scheduler behavior | Always live | Products are not changed |
| Scheduler behavior | None | Products are not changed |
| Scheduler behavior | Product count over 250 | All product pages are paginated and evaluated |
| Scheduler behavior | Shopify product update userErrors | Sync log records error; job summary increments `errorCount` |
| Storefront collection | Collection page with countdown | Notice renders above grid; timer uses server time |
| Storefront collection | Collection page with message | Message renders above grid |
| Storefront collection | Mode none | No notice rendered |
| Storefront product | Product page with collection context | Context collection schedule wins |
| Storefront product | Direct product page | Resolver finds applicable scheduled collection or returns none |
| Storefront expired | Countdown end is in the past | Notice hides by default |
| Storefront mobile | Product and collection pages at mobile width | Notice does not overlap form/grid and text wraps cleanly |
| Checkout extension | Plus checkout block enabled, one scheduled item | Block renders message or countdown |
| Checkout extension | Empty cart / unsupported line data | Extension renders nothing |
| Checkout extension | Multiple scheduled collections, one message | Message wins over countdown |
| Checkout extension | Multiple active countdowns | Earliest end date wins |
| Checkout extension | Upcoming countdowns only | Nearest start date wins |
| Checkout privacy | Endpoint errors | Logs omit cart, customer, checkout token, product IDs, variant IDs, and request body |
| Checkout hardening | GET request to `/api/checkout-schedule` | Returns fail-closed 405 payload and does not resolve IDs |
| Checkout hardening | Oversized JSON or over 50 IDs | Returns fail-closed `mode=none` |
| Checkout hardening | Excessive requests from one client/shop bucket | Returns fail-closed `429` payload without logging private checkout data |

## Test App And Theme Flow

Use the isolated test app and test theme first. Keep production app and production theme untouched until client review is complete.

1. Deploy the app server to the test host.
2. Confirm `/health` responds.
3. Run database migrations on test only.
4. Open the embedded app for the test shop.
5. Confirm dashboard metafield definitions are present.
6. Configure one test collection for each mode:
   - Managed + countdown.
   - Always live + message.
   - None.
   - Checkout inherit storefront.
   - Checkout override message.
7. Run a dry-run scheduler sync.
8. Run a real scheduler sync only on test products.
9. Push the storefront theme extension to the test theme.
10. Enable the app embed/block in the test theme.
11. Verify product and collection pages on desktop and mobile.
12. If the test shop has Plus checkout extensibility, deploy and enable the checkout extension block in checkout editor.

## Checkout Activation Requirements

Before checkout acceptance testing:
- Confirm the merchant store is on Shopify Plus for checkout information/shipping/payment step extensions.
- Confirm `network_access = true` is approved for the checkout extension.
- Configure `app_url` as HTTPS only.
- Configure `shop_domain` only if the runtime shop domain is not available.
- Confirm the extension target `purchase.checkout.block.render` is visible in checkout editor.

If Plus is not available:
- Do not enable checkout claims in client review.
- Keep storefront notices as the supported path.
- Keep the existing third-party countdown app enabled until storefront acceptance is signed off.

## Production Rollout Checklist

App server:
- Confirm final branch diff contains no secrets.
- Run all verification commands.
- Build Docker image.
- Configure reverse proxy or host-level rate limiting for `/api/checkout-schedule`.
- Deploy to test host and smoke test.
- Record previous production image/tag or commit for rollback.
- Deploy to production only after approval.
- Check `/health`.
- Check embedded admin app loads.
- Run `dryRun=true` scheduler first.
- Run one scoped real scheduler sync if approved.

Theme extension:
- Push to test theme first.
- Verify app URL setting is production HTTPS URL before production theme activation.
- Enable production theme block only after visual acceptance.
- Leave Essential Countdown Timer enabled until the new block is accepted.
- Disable Essential Countdown Timer only after product and collection pages match acceptance criteria.

Checkout extension:
- Deploy extension through Shopify CLI/app deployment.
- Enable only on Plus checkout.
- Place block in checkout editor.
- Test single item, multiple items, message priority, countdown priority, and empty cart.
- Keep fallback storefront notices active.

## Rollback Checklist

App server rollback:
- Revert to the previous Docker image/tag or previous deployed commit.
- Restart the app container.
- Confirm `/health`.
- Run a scheduler dry run.
- Inspect recent `SyncLog` errors.

Theme extension rollback:
- Disable the Scheduler app embed/block in the theme editor.
- Re-enable Essential Countdown Timer if it was disabled.
- Revert to the previous theme version if block settings were changed.

Checkout extension rollback:
- Remove the Scheduler checkout block from checkout editor.
- Disable or roll back the checkout extension deployment.
- Keep storefront notices active.

Data rollback:
- Do not bulk delete metafields.
- If a collection was misconfigured, edit that collection's explicit mode fields in admin.
- If a bad checkout message was saved, set `checkout_mode=none` or clear `checkout_message` for the affected collection.
