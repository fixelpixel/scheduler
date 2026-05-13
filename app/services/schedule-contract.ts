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
export const NOTICE_VARIANTS = [
  "theme_native",
  "inline_product_form",
  "collection_bar",
  "compact_banner",
] as const;

export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];
export type StorefrontMode = (typeof STOREFRONT_MODES)[number];
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
export type NoticeVariant = (typeof NOTICE_VARIANTS)[number];
export type LegacyDisplayMode = "countdown" | "message" | "none";

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function normalizeAvailabilityMode(value: unknown): AvailabilityMode {
  return isOneOf(AVAILABILITY_MODES, value) ? value : "none";
}

export function normalizeStorefrontMode(value: unknown): StorefrontMode {
  return isOneOf(STOREFRONT_MODES, value) ? value : "none";
}

export function normalizeCheckoutMode(value: unknown): CheckoutMode {
  return isOneOf(CHECKOUT_MODES, value) ? value : "inherit_storefront";
}

export function normalizeNoticeVariant(value: unknown): NoticeVariant {
  return isOneOf(NOTICE_VARIANTS, value) ? value : "theme_native";
}

export function normalizeLegacyDisplayMode(value: unknown): LegacyDisplayMode {
  return value === "countdown" || value === "message" || value === "none" ? value : "none";
}

export function legacyDisplayModeToStorefrontMode(value: unknown): StorefrontMode {
  const legacyMode = normalizeLegacyDisplayMode(value);
  return legacyMode === "countdown" ? "countdown_to_end" : legacyMode;
}

export function storefrontModeToLegacyDisplayMode(value: StorefrontMode): LegacyDisplayMode {
  return value === "countdown_to_end" ? "countdown" : value;
}

export function resolveEffectiveCheckoutMode(
  checkoutMode: CheckoutMode,
  storefrontMode: StorefrontMode,
): StorefrontMode {
  return checkoutMode === "inherit_storefront" ? storefrontMode : checkoutMode;
}
