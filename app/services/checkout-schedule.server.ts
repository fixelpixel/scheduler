import { shopRepository } from "../repositories/shop.repository.server";
import {
  CHECKOUT_MESSAGE_KEY,
  CHECKOUT_MODE_KEY,
  CUSTOM_MESSAGE_KEY,
  DISPLAY_MODE_KEY,
  END_DATE_KEY_FALLBACK,
  SCHEDULE_NAMESPACE_FALLBACK,
  START_DATE_KEY_FALLBACK,
  STOREFRONT_MODE_KEY,
  legacyDisplayModeToStorefrontMode,
  normalizeCheckoutMode,
  normalizeStorefrontMode,
  resolveEffectiveCheckoutMode,
  type StorefrontMode,
} from "./schedule-contract";
import { shopifyAdminGraphqlRequest } from "./shopify-admin.server";

export type CheckoutScheduleResponse = {
  mode: "none" | "countdown_to_end" | "message";
  endDate: string | null;
  message: string | null;
  serverTime: string;
};

export type CheckoutScheduleCandidate = {
  handle: string | null;
  title: string | null;
  storefrontMode: string | null;
  displayMode: string | null;
  customMessage: string | null;
  checkoutMode: string | null;
  checkoutMessage: string | null;
  startDate: string | null;
  endDate: string | null;
};

type CollectionNode = {
  handle?: string | null;
  title?: string | null;
  startDate?: { value?: string | null } | null;
  endDate?: { value?: string | null } | null;
  storefrontMode?: { value?: string | null } | null;
  displayMode?: { value?: string | null } | null;
  customMessage?: { value?: string | null } | null;
  checkoutMode?: { value?: string | null } | null;
  checkoutMessage?: { value?: string | null } | null;
};

type ProductNode = {
  __typename?: string;
  id?: string | null;
  collections?: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    } | null;
    nodes?: CollectionNode[];
  } | null;
};

type VariantNode = {
  __typename?: string;
  product?: ProductNode | null;
};

type CheckoutScheduleData = {
  variants?: Array<VariantNode | null> | null;
};

type ProductCollectionsData = {
  product?: ProductNode | null;
};

const PRODUCT_LIMIT = 50;
const COLLECTIONS_PAGE_SIZE = 100;
const MAX_COLLECTION_PAGES_PER_PRODUCT = 10;

export type CheckoutScheduleErrorCode = "collection_pagination_limit_exceeded";

export class CheckoutScheduleResolutionError extends Error {
  constructor(readonly code: CheckoutScheduleErrorCode) {
    super(code);
    this.name = "CheckoutScheduleResolutionError";
  }
}

export function emptyCheckoutSchedule(now = new Date()): CheckoutScheduleResponse {
  return {
    mode: "none",
    endDate: null,
    message: null,
    serverTime: now.toISOString(),
  };
}

export function isValidShopDomain(shop: string | null | undefined): shop is string {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop ?? "");
}

export function isValidProductGid(id: string): boolean {
  return /^gid:\/\/shopify\/Product\/\d+$/.test(id);
}

export function isValidProductVariantGid(id: string): boolean {
  return /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id);
}

export function parseGidList(value: string | null, isValid: (id: string) => boolean): string[] | null {
  if (!value?.trim()) return [];

  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!ids.length) return [];
  if (!ids.every(isValid)) return null;

  return [...new Set(ids)].slice(0, 50);
}

export function selectCheckoutSchedule(
  candidates: CheckoutScheduleCandidate[],
  now = new Date(),
  shopTimezone = "UTC",
): CheckoutScheduleResponse {
  const messageCandidate = candidates
    .map((candidate) => ({
      candidate,
      mode: getEffectiveCheckoutMode(candidate),
      message: getCheckoutMessage(candidate),
    }))
    .filter((entry): entry is { candidate: CheckoutScheduleCandidate; mode: "message"; message: string } => {
      return entry.mode === "message" && !!entry.message;
    })
    .sort((a, b) => compareCandidates(a.candidate, b.candidate))[0];

  if (messageCandidate) {
    return {
      mode: "message",
      endDate: null,
      message: messageCandidate.message,
      serverTime: now.toISOString(),
    };
  }

  const countdownCandidates = candidates.filter((candidate) => {
    return getEffectiveCheckoutMode(candidate) === "countdown_to_end";
  });

  const activeCountdown = countdownCandidates
    .map((candidate) => ({
      candidate,
      start: parseScheduleInstant(candidate.startDate, shopTimezone, "start"),
      end: parseScheduleInstant(candidate.endDate, shopTimezone, "end"),
    }))
    .filter((entry): entry is { candidate: CheckoutScheduleCandidate; start: number | null; end: number } => {
      return entry.end !== null && (entry.start === null || entry.start <= now.getTime()) && now.getTime() < entry.end;
    })
    .sort((a, b) => a.end - b.end || compareCandidates(a.candidate, b.candidate))[0];

  if (activeCountdown) {
    return toCountdownResponse(activeCountdown.candidate, activeCountdown.end, now);
  }

  const upcomingCountdown = countdownCandidates
    .map((candidate) => ({
      candidate,
      start: parseScheduleInstant(candidate.startDate, shopTimezone, "start"),
      end: parseScheduleInstant(candidate.endDate, shopTimezone, "end"),
    }))
    .filter((entry): entry is { candidate: CheckoutScheduleCandidate; start: number; end: number } => {
      return entry.start !== null && entry.end !== null && entry.start > now.getTime() && entry.end > now.getTime();
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || compareCandidates(a.candidate, b.candidate))[0];

  if (upcomingCountdown) {
    return toCountdownResponse(upcomingCountdown.candidate, upcomingCountdown.end, now);
  }

  return emptyCheckoutSchedule(now);
}

export async function getCheckoutSchedule(input: {
  shop: string;
  productIds?: string[];
  variantIds?: string[];
  now?: Date;
}): Promise<CheckoutScheduleResponse> {
  const now = input.now ?? new Date();

  if (!isValidShopDomain(input.shop)) {
    return emptyCheckoutSchedule(now);
  }

  const productIds = [...new Set(input.productIds ?? [])].filter(isValidProductGid).slice(0, PRODUCT_LIMIT);
  const variantIds = [...new Set(input.variantIds ?? [])].filter(isValidProductVariantGid).slice(0, PRODUCT_LIMIT);

  if (!productIds.length && !variantIds.length) {
    return emptyCheckoutSchedule(now);
  }

  const shop = await shopRepository.findByShopDomain(input.shop);
  if (!shop) {
    return emptyCheckoutSchedule(now);
  }

  const namespace = shop.metafieldNamespace || SCHEDULE_NAMESPACE_FALLBACK;
  const startKey = shop.startDateKey || START_DATE_KEY_FALLBACK;
  const endKey = shop.endDateKey || END_DATE_KEY_FALLBACK;
  const shopTimezone = shop.shopIanaTimezone || "UTC";
  const candidates = await getCollectionsForCheckoutItems(input.shop, {
    productIds,
    variantIds,
    namespace,
    startKey,
    endKey,
  });

  return selectCheckoutSchedule(candidates, now, shopTimezone);
}

function getStorefrontMode(candidate: CheckoutScheduleCandidate): StorefrontMode {
  const normalizedStorefrontMode = normalizeStorefrontMode(candidate.storefrontMode);
  if (normalizedStorefrontMode !== "none" || candidate.storefrontMode === "none") {
    return normalizedStorefrontMode;
  }

  return legacyDisplayModeToStorefrontMode(candidate.displayMode);
}

function getEffectiveCheckoutMode(candidate: CheckoutScheduleCandidate): StorefrontMode {
  return resolveEffectiveCheckoutMode(normalizeCheckoutMode(candidate.checkoutMode), getStorefrontMode(candidate));
}

function getCheckoutMessage(candidate: CheckoutScheduleCandidate): string | null {
  return candidate.checkoutMessage?.trim() || candidate.customMessage?.trim() || null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseScheduleInstant(
  value: string | null | undefined,
  shopTimezone: string,
  boundary: "start" | "end",
): number | null {
  if (!value) return null;
  if (DATE_PATTERN.test(value)) return getDayBoundaryInstantMs(value, shopTimezone, boundary);

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const offsetValue = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")
    ?.value;

  if (!offsetValue || offsetValue === "GMT" || offsetValue === "UTC") {
    return 0;
  }

  const match = offsetValue.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const [, sign, hoursText, minutesText] = match;
  const absoluteMinutes = Number(hoursText) * 60 + Number(minutesText ?? "0");
  return sign === "-" ? -absoluteMinutes : absoluteMinutes;
}

function zonedDateTimeToInstantMs(input: {
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}): number {
  const utcGuess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
    input.millisecond ?? 0,
  );
  let resolved = utcGuess;

  for (let index = 0; index < 3; index += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(input.timeZone, new Date(resolved));
    const nextResolved = utcGuess - offsetMinutes * 60_000;
    if (nextResolved === resolved) break;
    resolved = nextResolved;
  }

  return resolved;
}

function getDayBoundaryInstantMs(value: string, timeZone: string, boundary: "start" | "end"): number {
  const [yearText, monthText, dayText] = value.split("-");

  return zonedDateTimeToInstantMs({
    timeZone,
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: boundary === "start" ? 0 : 23,
    minute: boundary === "start" ? 0 : 59,
    second: boundary === "start" ? 0 : 59,
    millisecond: boundary === "start" ? 0 : 999,
  });
}

function compareCandidates(a: CheckoutScheduleCandidate, b: CheckoutScheduleCandidate): number {
  return `${a.title ?? ""}:${a.handle ?? ""}`.localeCompare(`${b.title ?? ""}:${b.handle ?? ""}`);
}

function toCountdownResponse(
  candidate: CheckoutScheduleCandidate,
  end: number,
  now: Date,
): CheckoutScheduleResponse {
  return {
    mode: "countdown_to_end",
    endDate: new Date(end).toISOString(),
    message: null,
    serverTime: now.toISOString(),
  };
}

async function getCollectionsForCheckoutItems(
  shopDomain: string,
  input: {
    productIds: string[];
    variantIds: string[];
    namespace: string;
    startKey: string;
    endKey: string;
  },
): Promise<CheckoutScheduleCandidate[]> {
  const productIds = await resolveCheckoutProductIds(shopDomain, input.productIds, input.variantIds);
  const candidates: CheckoutScheduleCandidate[] = [];

  for (const productId of productIds) {
    candidates.push(
      ...(await getCollectionsForProductId(shopDomain, {
        productId,
        namespace: input.namespace,
        startKey: input.startKey,
        endKey: input.endKey,
      })),
    );
  }

  return dedupeCandidates(candidates);
}

async function resolveCheckoutProductIds(
  shopDomain: string,
  productIds: string[],
  variantIds: string[],
): Promise<string[]> {
  const resolved = new Set(productIds.filter(isValidProductGid));

  if (variantIds.length) {
    const data = await shopifyAdminGraphqlRequest<CheckoutScheduleData, Record<string, unknown>>(
      shopDomain,
      `#graphql
        query CheckoutScheduleVariantProducts($variantIds: [ID!]!) {
          variants: nodes(ids: $variantIds) {
            __typename
            ... on ProductVariant {
              product {
                id
              }
            }
          }
        }
      `,
      { variantIds },
    );

    for (const variant of data.variants ?? []) {
      const productId = variant?.product?.id;
      if (productId && isValidProductGid(productId)) {
        resolved.add(productId);
      }
    }
  }

  return [...resolved].slice(0, PRODUCT_LIMIT);
}

async function getCollectionsForProductId(
  shopDomain: string,
  input: {
    productId: string;
    namespace: string;
    startKey: string;
    endKey: string;
  },
): Promise<CheckoutScheduleCandidate[]> {
  const candidates: CheckoutScheduleCandidate[] = [];
  let after: string | null = null;
  let completedPagination = false;

  for (let page = 0; page < MAX_COLLECTION_PAGES_PER_PRODUCT; page += 1) {
    const data: ProductCollectionsData = await shopifyAdminGraphqlRequest<ProductCollectionsData, Record<string, unknown>>(
      shopDomain,
      `#graphql
        query CheckoutScheduleProductCollections(
          $productId: ID!
          $after: String
          $first: Int!
          $namespace: String!
          $startKey: String!
          $endKey: String!
          $storefrontModeKey: String!
          $displayModeKey: String!
          $customMessageKey: String!
          $checkoutModeKey: String!
          $checkoutMessageKey: String!
        ) {
          product(id: $productId) {
            __typename
            collections(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                handle
                title
                startDate: metafield(namespace: $namespace, key: $startKey) { value }
                endDate: metafield(namespace: $namespace, key: $endKey) { value }
                storefrontMode: metafield(namespace: $namespace, key: $storefrontModeKey) { value }
                displayMode: metafield(namespace: $namespace, key: $displayModeKey) { value }
                customMessage: metafield(namespace: $namespace, key: $customMessageKey) { value }
                checkoutMode: metafield(namespace: $namespace, key: $checkoutModeKey) { value }
                checkoutMessage: metafield(namespace: $namespace, key: $checkoutMessageKey) { value }
              }
            }
          }
        }
      `,
      {
        productId: input.productId,
        after,
        first: COLLECTIONS_PAGE_SIZE,
        namespace: input.namespace,
        startKey: input.startKey,
        endKey: input.endKey,
        storefrontModeKey: STOREFRONT_MODE_KEY,
        displayModeKey: DISPLAY_MODE_KEY,
        customMessageKey: CUSTOM_MESSAGE_KEY,
        checkoutModeKey: CHECKOUT_MODE_KEY,
        checkoutMessageKey: CHECKOUT_MESSAGE_KEY,
      },
    );

    const connection: ProductNode["collections"] = data.product?.collections;
    candidates.push(
      ...(connection?.nodes ?? [])
        .map(mapCollectionNode)
        .filter((candidate: CheckoutScheduleCandidate | null): candidate is CheckoutScheduleCandidate => {
          return candidate !== null;
        }),
    );

    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      completedPagination = true;
      break;
    }

    after = connection.pageInfo.endCursor;
  }

  if (!completedPagination) {
    throw new CheckoutScheduleResolutionError("collection_pagination_limit_exceeded");
  }

  return candidates;
}

function mapCollectionNode(node: CollectionNode | null | undefined): CheckoutScheduleCandidate | null {
  if (!node) return null;

  return {
    handle: node.handle ?? null,
    title: node.title ?? null,
    storefrontMode: node.storefrontMode?.value ?? null,
    displayMode: node.displayMode?.value ?? null,
    customMessage: node.customMessage?.value ?? null,
    checkoutMode: node.checkoutMode?.value ?? null,
    checkoutMessage: node.checkoutMessage?.value ?? null,
    startDate: node.startDate?.value ?? null,
    endDate: node.endDate?.value ?? null,
  };
}

function dedupeCandidates(candidates: Array<CheckoutScheduleCandidate | null>): CheckoutScheduleCandidate[] {
  const deduped = new Map<string, CheckoutScheduleCandidate>();

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.handle || `${candidate.title ?? ""}:${candidate.endDate ?? ""}:${candidate.checkoutMode ?? ""}`;
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}
