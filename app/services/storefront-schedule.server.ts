import { shopRepository } from "../repositories/shop.repository.server";
import {
  CUSTOM_MESSAGE_KEY,
  DISPLAY_MODE_KEY,
  NOTICE_SETTINGS_KEY,
  NOTICE_VARIANT_KEY,
  STOREFRONT_MODE_KEY,
  type NoticeVariant,
  normalizeNoticeVariant,
} from "./schedule-contract";
import { shopifyAdminGraphqlRequest } from "./shopify-admin.server";

export type StorefrontDisplayMode = "none" | "countdown_to_end" | "message";
export type StorefrontExpiredBehavior = "hide" | "show_expired_message";

export type StorefrontScheduleResponse = {
  mode: StorefrontDisplayMode;
  endDate: string | null;
  customMessage: string | null;
  collectionHandle: string | null;
  collectionTitle: string | null;
  noticeVariant: NoticeVariant;
  label: string | null;
  expiredBehavior: StorefrontExpiredBehavior;
  serverTime: string;
};

type CollectionDisplayCandidate = {
  handle: string | null;
  title: string | null;
  storefrontMode: string | null;
  displayMode: string | null;
  customMessage: string | null;
  startDate: string | null;
  endDate: string | null;
  noticeVariant: string | null;
  noticeSettings: string | null;
};

export function emptyStorefrontSchedule(now = new Date()): StorefrontScheduleResponse {
  return {
    mode: "none",
    endDate: null,
    customMessage: null,
    collectionHandle: null,
    collectionTitle: null,
    noticeVariant: "theme_native",
    label: null,
    expiredBehavior: "hide",
    serverTime: now.toISOString(),
  };
}

export function isValidShopDomain(shop: string | null | undefined): shop is string {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop ?? "");
}

export function selectStorefrontSchedule(
  candidates: CollectionDisplayCandidate[],
  now = new Date(),
  shopTimezone = "UTC",
): StorefrontScheduleResponse {
  const messageCandidate = candidates
    .filter((candidate) => {
      return getStorefrontMode(candidate) === "message" && !!candidate.customMessage?.trim();
    })
    .sort(compareCandidates)[0];

  if (messageCandidate) {
    return toResponse(messageCandidate, "message", now, shopTimezone);
  }

  const countdownCandidates = candidates.filter((candidate) => {
    return getStorefrontMode(candidate) === "countdown_to_end";
  });

  const activeCountdown = countdownCandidates
    .map((candidate) => ({
      candidate,
      start: parseScheduleInstant(candidate.startDate, shopTimezone, "start"),
      end: parseScheduleInstant(candidate.endDate, shopTimezone, "end"),
    }))
    .filter((entry): entry is { candidate: CollectionDisplayCandidate; start: number | null; end: number } => {
      return entry.end !== null && (entry.start === null || entry.start <= now.getTime()) && now.getTime() < entry.end;
    })
    .sort((a, b) => a.end - b.end || compareCandidates(a.candidate, b.candidate))[0]?.candidate;

  if (activeCountdown) {
    return toResponse(activeCountdown, "countdown_to_end", now, shopTimezone);
  }

  // Direct product pages can be ambiguous when a product belongs to multiple
  // collections. If none is clearly active yet, use the nearest future order
  // deadline instead of exposing an expired or empty notice.
  const upcomingCountdown = countdownCandidates
    .map((candidate) => ({
      candidate,
      start: parseScheduleInstant(candidate.startDate, shopTimezone, "start"),
      end: parseScheduleInstant(candidate.endDate, shopTimezone, "end"),
    }))
    .filter((entry): entry is { candidate: CollectionDisplayCandidate; start: number; end: number } => {
      return entry.start !== null && entry.end !== null && entry.start > now.getTime() && entry.end > now.getTime();
    })
    .sort((a, b) => a.end - b.end || compareCandidates(a.candidate, b.candidate))[0]?.candidate;

  if (upcomingCountdown) {
    return toResponse(upcomingCountdown, "countdown_to_end", now, shopTimezone);
  }

  return emptyStorefrontSchedule(now);
}

export async function getStorefrontSchedule(input: {
  shop: string;
  collectionHandle?: string | null;
  productHandle?: string | null;
  now?: Date;
}): Promise<StorefrontScheduleResponse> {
  const now = input.now ?? new Date();

  if (!isValidShopDomain(input.shop)) {
    return emptyStorefrontSchedule(now);
  }

  const shop = await shopRepository.findByShopDomain(input.shop);
  if (!shop) {
    return emptyStorefrontSchedule(now);
  }

  const namespace = shop.metafieldNamespace || "schedule";
  const startKey = shop.startDateKey || "start_date";
  const endKey = shop.endDateKey || "end_date";
  const shopTimezone = shop.shopIanaTimezone || "UTC";

  if (input.collectionHandle) {
    const collection = await getCollectionByHandle(input.shop, {
      handle: input.collectionHandle,
      namespace,
      startKey,
      endKey,
    });

    return collection ? selectStorefrontSchedule([collection], now, shopTimezone) : emptyStorefrontSchedule(now);
  }

  if (input.productHandle) {
    const collections = await getCollectionsForProduct(input.shop, {
      handle: input.productHandle,
      namespace,
      startKey,
      endKey,
    });

    return selectStorefrontSchedule(collections, now, shopTimezone);
  }

  return emptyStorefrontSchedule(now);
}

function normalizeStorefrontMode(value: string | null | undefined): StorefrontDisplayMode {
  return value === "countdown_to_end" || value === "message" || value === "none" ? value : "none";
}

function getStorefrontMode(candidate: CollectionDisplayCandidate): StorefrontDisplayMode {
  if (candidate.storefrontMode) {
    return normalizeStorefrontMode(candidate.storefrontMode);
  }

  if (candidate.displayMode === "countdown") return "countdown_to_end";
  if (candidate.displayMode === "message") return "message";
  return "none";
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

function compareCandidates(a: CollectionDisplayCandidate, b: CollectionDisplayCandidate): number {
  return `${a.title ?? ""}:${a.handle ?? ""}`.localeCompare(`${b.title ?? ""}:${b.handle ?? ""}`);
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

  if (!match) {
    return 0;
  }

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

    if (nextResolved === resolved) {
      break;
    }

    resolved = nextResolved;
  }

  return resolved;
}

function getDayBoundaryInstantMs(
  value: string,
  timeZone: string,
  boundary: "start" | "end",
): number {
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

function toResponse(
  candidate: CollectionDisplayCandidate,
  mode: StorefrontDisplayMode,
  now: Date,
  shopTimezone: string,
): StorefrontScheduleResponse {
  const noticeSettings = parseNoticeSettings(candidate);

  return {
    mode,
    endDate: mode === "countdown_to_end"
      ? normalizeScheduleOutput(candidate.endDate, shopTimezone, "end")
      : candidate.endDate,
    customMessage: mode === "message" ? candidate.customMessage?.trim() || null : null,
    collectionHandle: candidate.handle,
    collectionTitle: candidate.title,
    noticeVariant: noticeSettings.noticeVariant,
    label: noticeSettings.label,
    expiredBehavior: noticeSettings.expiredBehavior,
    serverTime: now.toISOString(),
  };
}

function parseNoticeSettings(candidate: CollectionDisplayCandidate): {
  noticeVariant: NoticeVariant;
  label: string | null;
  expiredBehavior: StorefrontExpiredBehavior;
} {
  let settings: unknown = null;

  if (candidate.noticeSettings?.trim()) {
    try {
      settings = JSON.parse(candidate.noticeSettings);
    } catch (_error) {
      return {
        noticeVariant: "theme_native",
        label: null,
        expiredBehavior: "hide",
      };
    }
  }

  const settingsRecord = isPlainRecord(settings) ? settings : {};
  const label = typeof settingsRecord.label === "string" && settingsRecord.label.trim()
    ? settingsRecord.label.trim()
    : null;
  const expiredBehavior = settingsRecord.expiredBehavior === "show_expired_message"
    ? "show_expired_message"
    : "hide";

  return {
    noticeVariant: normalizeNoticeVariant(candidate.noticeVariant),
    label,
    expiredBehavior,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeScheduleOutput(
  value: string | null | undefined,
  shopTimezone: string,
  boundary: "start" | "end",
): string | null {
  const instant = parseScheduleInstant(value, shopTimezone, boundary);
  return instant === null ? null : new Date(instant).toISOString();
}

function collectionFragment(namespace: string, startKey: string, endKey: string) {
  return {
    namespace,
    startKey,
    endKey,
    storefrontModeKey: STOREFRONT_MODE_KEY,
    displayModeKey: DISPLAY_MODE_KEY,
    customMessageKey: CUSTOM_MESSAGE_KEY,
    noticeVariantKey: NOTICE_VARIANT_KEY,
    noticeSettingsKey: NOTICE_SETTINGS_KEY,
  };
}

async function getCollectionByHandle(
  shopDomain: string,
  input: { handle: string; namespace: string; startKey: string; endKey: string },
): Promise<CollectionDisplayCandidate | null> {
  const data = await shopifyAdminGraphqlRequest<any, any>(
    shopDomain,
    `#graphql
      query StorefrontScheduleCollection(
        $handle: String!
        $namespace: String!
        $startKey: String!
        $endKey: String!
        $storefrontModeKey: String!
        $displayModeKey: String!
        $customMessageKey: String!
        $noticeVariantKey: String!
        $noticeSettingsKey: String!
      ) {
        collectionByHandle(handle: $handle) {
          handle
          title
          startDate: metafield(namespace: $namespace, key: $startKey) { value }
          endDate: metafield(namespace: $namespace, key: $endKey) { value }
          storefrontMode: metafield(namespace: $namespace, key: $storefrontModeKey) { value }
          displayMode: metafield(namespace: $namespace, key: $displayModeKey) { value }
          customMessage: metafield(namespace: $namespace, key: $customMessageKey) { value }
          noticeVariant: metafield(namespace: $namespace, key: $noticeVariantKey) { value }
          noticeSettings: metafield(namespace: $namespace, key: $noticeSettingsKey) { value }
        }
      }
    `,
    { handle: input.handle, ...collectionFragment(input.namespace, input.startKey, input.endKey) },
  );

  return mapCollectionNode(data.collectionByHandle);
}

async function getCollectionsForProduct(
  shopDomain: string,
  input: { handle: string; namespace: string; startKey: string; endKey: string },
): Promise<CollectionDisplayCandidate[]> {
  const collections: CollectionDisplayCandidate[] = [];
  let after: string | null = null;
  let hasNextPage = false;

  do {
    const data: any = await shopifyAdminGraphqlRequest<any, any>(
      shopDomain,
      `#graphql
        query StorefrontScheduleProduct(
          $handle: String!
          $after: String
          $namespace: String!
          $startKey: String!
          $endKey: String!
          $storefrontModeKey: String!
          $displayModeKey: String!
          $customMessageKey: String!
          $noticeVariantKey: String!
          $noticeSettingsKey: String!
        ) {
          productByHandle(handle: $handle) {
            collections(first: 100, after: $after) {
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
                noticeVariant: metafield(namespace: $namespace, key: $noticeVariantKey) { value }
                noticeSettings: metafield(namespace: $namespace, key: $noticeSettingsKey) { value }
              }
            }
          }
        }
      `,
      {
        handle: input.handle,
        after,
        ...collectionFragment(input.namespace, input.startKey, input.endKey),
      },
    );

    const connection: any = data.productByHandle?.collections;
    collections.push(
      ...(connection?.nodes ?? [])
        .map(mapCollectionNode)
        .filter((collection: CollectionDisplayCandidate | null): collection is CollectionDisplayCandidate => {
          return collection !== null;
        }),
    );

    hasNextPage = connection?.pageInfo?.hasNextPage ?? false;
    after = connection?.pageInfo?.endCursor ?? null;
  } while (hasNextPage && after);

  return collections;
}

function mapCollectionNode(node: any): CollectionDisplayCandidate | null {
  if (!node) return null;

  return {
    handle: node.handle ?? null,
    title: node.title ?? null,
    storefrontMode: node.storefrontMode?.value ?? null,
    displayMode: node.displayMode?.value ?? null,
    customMessage: node.customMessage?.value ?? null,
    startDate: node.startDate?.value ?? null,
    endDate: node.endDate?.value ?? null,
    noticeVariant: node.noticeVariant?.value ?? null,
    noticeSettings: node.noticeSettings?.value ?? null,
  };
}
