# Scheduler Production Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Scheduler app production-review ready by separating schedule semantics into shared contracts, improving admin/storefront configuration, and adding a Shopify Plus-gated checkout notice path without changing existing publication behavior.

**Architecture:** Keep collection metafields as the source of truth and keep availability automation separate from all notice display modes. Add a shared schedule contract module used by admin, storefront, scheduler, and checkout code; add checkout-specific metafields and a public-safe checkout resolver; scaffold a checkout UI extension that renders only minimal schedule data. Deploy/test only through the test app, test theme, and Plus-enabled checkout preview before production.

**Tech Stack:** Remix, Shopify Polaris, Prisma, Shopify Admin GraphQL, Shopify theme app extension, Shopify checkout UI extension, vanilla storefront JS/CSS, Docker.

---

## Current Baseline

Working tree is intentionally dirty and already contains the previous storefront countdown work. Continue on branch `codex/scheduler-production-iteration`; do not revert unrelated edits. Verification before this plan: `npm run typecheck` passed, `npm run build` passed.

Known files involved:
- Admin: `app/routes/app.collections.tsx`, `app/routes/app.settings.tsx`, `app/routes/app._index.tsx`
- Scheduler: `app/jobs/run-schedule-job.server.ts`, `app/services/collection-scheduler.server.ts`, `app/services/scheduler-engine.server.ts`
- Storefront API: `app/services/storefront-schedule.server.ts`, `app/routes/api.storefront-schedule.tsx`
- Storefront theme extension: `extensions/storefront-countdown/blocks/scheduler-countdown.liquid`, `extensions/storefront-countdown/assets/scheduler-countdown.js`, `extensions/storefront-countdown/assets/scheduler-countdown.css`
- Data: `prisma/schema.prisma`
- New checkout code: `app/services/checkout-schedule.server.ts`, `app/routes/api.checkout-schedule.tsx`, `extensions/checkout-schedule/*`

## Task 1: Shared Schedule Contract And Regression Checks

**Ownership:** Shared schedule constants/helpers only. Do not edit admin UI or extension files.

**Files:**
- Create: `app/services/schedule-contract.ts`
- Create: `scripts/verify-schedule-contract.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add a verification script before behavior changes**

Create `scripts/verify-schedule-contract.mjs` with a small Node assertion harness. It should fail until `app/services/schedule-contract.ts` exists and exports the expected string constants/functions after build.

Expected checks:
```js
assert.deepEqual(contract.AVAILABILITY_MODES, ["managed", "always_live", "none"]);
assert.deepEqual(contract.STOREFRONT_MODES, ["none", "countdown_to_end", "message"]);
assert.deepEqual(contract.CHECKOUT_MODES, ["inherit_storefront", "none", "countdown_to_end", "message"]);
assert.equal(contract.legacyDisplayModeToStorefrontMode("countdown"), "countdown_to_end");
assert.equal(contract.legacyDisplayModeToStorefrontMode("message"), "message");
assert.equal(contract.legacyDisplayModeToStorefrontMode("none"), "none");
assert.equal(contract.storefrontModeToLegacyDisplayMode("countdown_to_end"), "countdown");
assert.equal(contract.resolveEffectiveCheckoutMode("inherit_storefront", "message"), "message");
assert.equal(contract.resolveEffectiveCheckoutMode("none", "message"), "none");
```

- [ ] **Step 2: Run the verification script and confirm RED**

Run: `node scripts/verify-schedule-contract.mjs`

Expected: failure because `schedule-contract.ts` does not exist or does not export the contract yet.

- [ ] **Step 3: Implement the shared contract**

Create `app/services/schedule-contract.ts` exporting:
```ts
export const SCHEDULE_NAMESPACE_FALLBACK = "schedule";
export const START_DATE_KEY_FALLBACK = "start_date";
export const END_DATE_KEY_FALLBACK = "end_date";
export const AVAILABILITY_MODE_KEY = "availability_mode";
export const STOREFRONT_MODE_KEY = "storefront_mode";
export const DISPLAY_MODE_KEY = "display_mode";
export const CUSTOM_MESSAGE_KEY = "custom_message";
export const CHECKOUT_MODE_KEY = "checkout_mode";
export const CHECKOUT_MESSAGE_KEY = "checkout_message";
export const NOTICE_VARIANT_KEY = "notice_variant";
export const NOTICE_SETTINGS_KEY = "notice_settings";

export const AVAILABILITY_MODES = ["managed", "always_live", "none"] as const;
export const STOREFRONT_MODES = ["none", "countdown_to_end", "message"] as const;
export const CHECKOUT_MODES = ["inherit_storefront", "none", "countdown_to_end", "message"] as const;
export const NOTICE_VARIANTS = ["theme_native", "inline_product_form", "collection_bar", "compact_banner"] as const;
```

Also export types and normalizers:
```ts
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];
export type StorefrontMode = (typeof STOREFRONT_MODES)[number];
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
export type NoticeVariant = (typeof NOTICE_VARIANTS)[number];
export type LegacyDisplayMode = "countdown" | "message" | "none";

export function normalizeAvailabilityMode(value: unknown): AvailabilityMode;
export function normalizeStorefrontMode(value: unknown): StorefrontMode;
export function normalizeCheckoutMode(value: unknown): CheckoutMode;
export function normalizeNoticeVariant(value: unknown): NoticeVariant;
export function normalizeLegacyDisplayMode(value: unknown): LegacyDisplayMode;
export function legacyDisplayModeToStorefrontMode(value: unknown): StorefrontMode;
export function storefrontModeToLegacyDisplayMode(value: StorefrontMode): LegacyDisplayMode;
export function resolveEffectiveCheckoutMode(checkoutMode: CheckoutMode, storefrontMode: StorefrontMode): StorefrontMode;
```

`resolveEffectiveCheckoutMode("inherit_storefront", storefrontMode)` returns the storefront mode; other checkout modes map directly to `StorefrontMode`.

- [ ] **Step 4: Add npm script**

Add to `package.json`:
```json
"verify:schedule-contract": "node scripts/verify-schedule-contract.mjs"
```

- [ ] **Step 5: Run GREEN verification**

Run:
```bash
npm run build
npm run verify:schedule-contract
npm run typecheck
```

Expected: all exit 0.

## Task 2: Admin Checkout Metafields And Clear Semantics

**Ownership:** Admin route/settings/dashboard only. Do not edit storefront extension or checkout extension.

**Files:**
- Modify: `app/routes/app.collections.tsx`
- Modify: `app/routes/app.settings.tsx`
- Modify: `app/routes/app._index.tsx`
- Modify: `app/services/collection-scheduler.server.ts`

- [ ] **Step 1: Import shared constants and remove duplicate literals**

Use `app/services/schedule-contract.ts` for keys, types, and normalizers in `app.routes/app.collections.tsx`. Keep UI behavior unchanged while replacing local duplicate helpers.

- [ ] **Step 2: Load checkout metafields in the collections editor**

Add to the GraphQL collection query:
```graphql
checkoutModeMeta: metafield(namespace: $namespace, key: "checkout_mode") { id value }
checkoutMessageMeta: metafield(namespace: $namespace, key: "checkout_message") { id value }
noticeVariantMeta: metafield(namespace: $namespace, key: "notice_variant") { id value }
noticeSettingsMeta: metafield(namespace: $namespace, key: "notice_settings") { id value }
```

Extend `CollectionRow` with those fields.

- [ ] **Step 3: Add checkout state to the edit surface**

Add state:
```ts
const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("inherit_storefront");
const [checkoutMessage, setCheckoutMessage] = useState("");
const [noticeVariant, setNoticeVariant] = useState<NoticeVariant>("theme_native");
```

Admin copy must say checkout display requires Shopify Plus checkout extensibility. Do not claim checkout works for non-Plus stores.

- [ ] **Step 4: Validate checkout settings**

Extend validation:
- `checkout_mode=countdown_to_end` requires `endDate`
- `checkout_mode=message` requires `checkoutMessage` or inherited `customMessage`
- `checkout_mode=inherit_storefront` uses storefront validation only
- checkout settings never change `availability_mode`

- [ ] **Step 5: Save checkout and style metafields**

On `setSchedule`, write:
```text
schedule.checkout_mode
schedule.checkout_message
schedule.notice_variant
```

Delete `checkout_message` when checkout mode is not `message` or when text is empty and inheritance is sufficient.

- [ ] **Step 6: Fix clear behavior**

Current `clearSchedule` clears dates and availability only. Change it to a safer `clearAvailability` action in UI copy, or expand deletion only if the button is clearly labelled `Clear all schedule settings`. Recommended for this phase: relabel to `Clear availability` and keep display metafields intact.

- [ ] **Step 7: Add metafield definitions**

In settings/dashboard definition creation, include:
```text
checkout_mode: single_line_text_field
checkout_message: multi_line_text_field
notice_variant: single_line_text_field
notice_settings: json
```

- [ ] **Step 8: Verify**

Run:
```bash
npm run typecheck
npm run build
npm run verify:schedule-contract
```

Expected: all exit 0.

## Task 3: Storefront Display Configurability

**Ownership:** Theme extension and storefront API response only. Do not edit admin save logic except for type imports if required.

**Files:**
- Modify: `app/services/storefront-schedule.server.ts`
- Modify: `app/routes/api.storefront-schedule.tsx`
- Modify: `extensions/storefront-countdown/blocks/scheduler-countdown.liquid`
- Modify: `extensions/storefront-countdown/assets/scheduler-countdown.js`
- Modify: `extensions/storefront-countdown/assets/scheduler-countdown.css`

- [ ] **Step 1: Extend public-safe response**

Add:
```ts
noticeVariant: "theme_native" | "inline_product_form" | "collection_bar" | "compact_banner";
label: string | null;
expiredBehavior: "hide" | "show_expired_message";
```

Do not include product IDs, customer data, cart data, tokens, or private config.

- [ ] **Step 2: Read optional notice metafields**

Read `notice_variant` and `notice_settings` from collection metafields. If JSON is invalid, fall back to `theme_native` and default label.

- [ ] **Step 3: Add block settings for merchant-controlled display**

In Liquid schema add:
```json
{ "type": "select", "id": "default_variant", "label": "Default style", "options": [...] },
{ "type": "text", "id": "countdown_label", "label": "Countdown label", "default": "Orders close in" },
{ "type": "color", "id": "background_color", "label": "Background", "default": "#111827" },
{ "type": "color", "id": "text_color", "label": "Text", "default": "#ffffff" },
{ "type": "color", "id": "accent_color", "label": "Accent", "default": "#38bdf8" }
```

Emit them as data attributes or CSS variables.

- [ ] **Step 4: Render variants in JS/CSS**

Add classes:
```text
scheduler-countdown--theme-native
scheduler-countdown--inline-product-form
scheduler-countdown--collection-bar
scheduler-countdown--compact-banner
```

Keep countdown accessible with `aria-live="polite"` and avoid layout overlap on mobile.

- [ ] **Step 5: Verify**

Run:
```bash
npm run typecheck
npm run build
```

Expected: all exit 0.

## Task 4: Checkout Schedule Endpoint

**Ownership:** New checkout service/route only plus shared contract imports. Do not scaffold checkout UI extension in this task.

**Files:**
- Create: `app/services/checkout-schedule.server.ts`
- Create: `app/routes/api.checkout-schedule.tsx`
- Modify: `app/services/schedule-contract.ts` only if a helper is missing

- [ ] **Step 1: Add pure selector tests through the verification script**

Extend `scripts/verify-schedule-contract.mjs` or add `scripts/verify-checkout-schedule.mjs` to check:
- checkout `message` beats countdown
- `inherit_storefront` maps to storefront mode/message
- multiple collections pick earliest active deadline for countdown
- empty/invalid input returns mode `none`

- [ ] **Step 2: Implement checkout response type**

```ts
export type CheckoutScheduleResponse = {
  mode: "none" | "countdown_to_end" | "message";
  endDate: string | null;
  message: string | null;
  serverTime: string;
};
```

- [ ] **Step 3: Implement public-safe route**

`/api/checkout-schedule` accepts:
```text
shop
productIds optional comma-separated Shopify product GIDs
variantIds optional comma-separated Shopify variant GIDs
```

Validate shop and ID shape. Fail closed with mode `none`. Return no-store cache headers. Log only shop, item count, and error message; never log full cart, checkout token, customer, address, line attributes, or raw request body.

- [ ] **Step 4: Resolve products to collections with Admin GraphQL**

Use Admin GraphQL through `shopifyAdminGraphqlRequest`. Query product IDs and/or variant IDs, then collections and schedule metafields. Keep response minimal.

- [ ] **Step 5: Verify**

Run:
```bash
npm run typecheck
npm run build
npm run verify:schedule-contract
```

Expected: all exit 0.

## Task 5: Shopify Plus-Gated Checkout UI Extension Scaffold

**Ownership:** Checkout extension files only, plus app TOML if extension registration requires it. Do not edit storefront theme extension.

**Files:**
- Create: `extensions/checkout-schedule/shopify.extension.toml`
- Create: `extensions/checkout-schedule/src/CheckoutSchedule.tsx`
- Create: `extensions/checkout-schedule/src/index.tsx`
- Create: `extensions/checkout-schedule/locales/en.default.json`
- Modify: `package.json` only if Shopify extension package scripts require it

- [ ] **Step 1: Scaffold official checkout extension shape**

Use Shopify checkout UI extension patterns. Target `purchase.checkout.block.render` first so the merchant can place the block in checkout editor.

- [ ] **Step 2: Configure capabilities deliberately**

Set network access only if required by current Shopify extension config:
```toml
[extensions.capabilities]
network_access = true
```

Do not request `block_progress`; this is display-only.

- [ ] **Step 3: Read checkout lines**

Use checkout extension APIs to read cart lines/merchandise IDs. Build a request using product/variant IDs only. Do not read or transmit buyer identity, address, checkout token, or customer data.

- [ ] **Step 4: Render minimal UI**

Render a Shopify UI extension banner/block:
- message mode: text banner
- countdown mode: deadline text or lightweight countdown
- none/error: render nothing

- [ ] **Step 5: Verify**

Run:
```bash
npm run typecheck
npm run build
```

Expected: all exit 0. Also document that checkout activation requires Shopify Plus.

## Task 6: Production Hardening, QA Matrix, And Deployment Docs

**Ownership:** Logging cleanup and documentation. Do not change feature behavior unless needed to remove unsafe logging.

**Files:**
- Modify: `app/jobs/run-schedule-job.server.ts`
- Modify: `README.md`
- Create: `docs/scheduler-production-qa.md`
- Create: `docs/scheduler-production-rollout.md`

- [ ] **Step 1: Remove noisy debug logging**

Remove scheduler logs that dump metafield definitions or full error objects. Keep concise operational logs with no secrets and no customer/cart data.

- [ ] **Step 2: Document QA matrix**

Cover:
- admin save/reload
- managed/always_live/none scheduler behavior
- legacy `display_mode` compatibility
- storefront collection/product/direct product pages
- message/countdown/none
- expired countdown
- mobile
- checkout Plus/non-Plus fallback
- multiple collections/cart ambiguity

- [ ] **Step 3: Document deployment and rollback**

Include:
- test app and test theme first
- test host only for acceptance
- checkout extension requires Shopify Plus
- production checklist
- rollback for app server, theme extension, checkout UI extension
- Essential Countdown Timer disabled only after acceptance

- [ ] **Step 4: Final verification**

Run:
```bash
npm run typecheck
npm run build
npm run verify:schedule-contract
git status --short
```

Expected: commands exit 0; status shows only intentional files.

## Execution Notes For Subagents

- Do not expose secrets, VPS credentials, Shopify tokens, private keys, checkout tokens, cart/customer data, or raw private request payloads.
- Use Shopify Admin GraphQL, not REST.
- Do not bulk rewrite collection metafields.
- Preserve existing scheduler behavior: only `availability_mode=managed` may change product status.
- Legacy `display_mode` is read compatibility only; it must not control product publication.
- Do not dispatch implementation subagents in parallel against overlapping files.
