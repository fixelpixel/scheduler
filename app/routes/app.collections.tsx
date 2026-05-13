import { useCallback, useState } from "react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  TextField,
  Select,
  Modal,
  Banner,
  Pagination,
  EmptyState,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";
import {
  AVAILABILITY_MODE_KEY,
  CHECKOUT_MESSAGE_KEY,
  CHECKOUT_MODE_KEY,
  CUSTOM_MESSAGE_KEY,
  DISPLAY_MODE_KEY,
  END_DATE_KEY_FALLBACK,
  NOTICE_VARIANT_KEY,
  NOTICE_SETTINGS_KEY,
  SCHEDULE_NAMESPACE_FALLBACK,
  START_DATE_KEY_FALLBACK,
  STOREFRONT_MODE_KEY,
  type AvailabilityMode,
  type CheckoutMode,
  type LegacyDisplayMode,
  type NoticeVariant,
  type StorefrontMode,
  legacyDisplayModeToStorefrontMode,
  normalizeAvailabilityMode,
  normalizeCheckoutMode,
  normalizeLegacyDisplayMode,
  normalizeNoticeVariant,
  normalizeStorefrontMode,
  storefrontModeToLegacyDisplayMode,
} from "../services/schedule-contract";

// ─── Types ───────────────────────────────────────────────────────────────────

type MetafieldNode = { id: string; value: string } | null;

type CollectionRow = {
  id: string;
  title: string;
  handle: string;
  isPublished: boolean;
  startDateMeta: MetafieldNode;
  endDateMeta: MetafieldNode;
  availabilityModeMeta: MetafieldNode;
  storefrontModeMeta: MetafieldNode;
  displayModeMeta: MetafieldNode;
  customMessageMeta: MetafieldNode;
  checkoutModeMeta: MetafieldNode;
  checkoutMessageMeta: MetafieldNode;
  noticeVariantMeta: MetafieldNode;
  noticeSettingsMeta: MetafieldNode;
};

type LoaderData = {
  collections: CollectionRow[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  namespace: string;
  startKey: string;
  endKey: string;
  shopTimezone: string;
  publicationId: string | null;
  configMissing: boolean;
};

const AVAILABILITY_MODE_OPTIONS: Array<{ label: string; value: AvailabilityMode }> = [
  { label: "Managed by Scheduler", value: "managed" },
  { label: "Always live / reporting only", value: "always_live" },
  { label: "No automation", value: "none" },
];

const STOREFRONT_MODE_OPTIONS: Array<{ label: string; value: StorefrontMode }> = [
  { label: "None", value: "none" },
  { label: "Countdown to order deadline", value: "countdown_to_end" },
  { label: "Custom message", value: "message" },
];

const CHECKOUT_MODE_OPTIONS: Array<{ label: string; value: CheckoutMode }> = [
  { label: "Inherit storefront notice", value: "inherit_storefront" },
  { label: "None", value: "none" },
  { label: "Countdown to order deadline", value: "countdown_to_end" },
  { label: "Custom checkout message", value: "message" },
];

const NOTICE_VARIANT_OPTIONS: Array<{ label: string; value: NoticeVariant }> = [
  { label: "Theme native", value: "theme_native" },
  { label: "Inline product form", value: "inline_product_form" },
  { label: "Collection bar", value: "collection_bar" },
  { label: "Compact banner", value: "compact_banner" },
];

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopRepository.findByShopDomain(session.shop);

  if (!shop?.targetPublicationId) {
    return json<LoaderData>({
      collections: [],
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
      namespace: shop?.metafieldNamespace ?? SCHEDULE_NAMESPACE_FALLBACK,
      startKey: shop?.startDateKey ?? START_DATE_KEY_FALLBACK,
      endKey: shop?.endDateKey ?? END_DATE_KEY_FALLBACK,
      shopTimezone: shop?.shopIanaTimezone ?? "UTC",
      publicationId: null,
      configMissing: true,
    });
  }

  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? null;
  const before = url.searchParams.get("before") ?? null;
  const search = url.searchParams.get("q") ?? "";
  const PAGE_SIZE = 20;

  const namespace = shop.metafieldNamespace;
  const startKey = shop.startDateKey;
  const endKey = shop.endDateKey;
  const publicationId = shop.targetPublicationId;

  const variables: Record<string, unknown> = {
    publicationId,
    namespace,
    startKey,
    endKey,
    availabilityModeKey: AVAILABILITY_MODE_KEY,
    storefrontModeKey: STOREFRONT_MODE_KEY,
    displayModeKey: DISPLAY_MODE_KEY,
    customMessageKey: CUSTOM_MESSAGE_KEY,
    checkoutModeKey: CHECKOUT_MODE_KEY,
    checkoutMessageKey: CHECKOUT_MESSAGE_KEY,
    noticeVariantKey: NOTICE_VARIANT_KEY,
    noticeSettingsKey: NOTICE_SETTINGS_KEY,
    query: search || null,
  };

  // Cursor-based pagination: either forward (after) or backward (before)
  if (before) {
    variables.last = PAGE_SIZE;
    variables.before = before;
  } else {
    variables.first = PAGE_SIZE;
    variables.after = after;
  }

  const response = await admin.graphql(
    `#graphql
    query GetCollectionsForEditor(
      $first: Int
      $last: Int
      $after: String
      $before: String
      $query: String
      $publicationId: ID!
      $namespace: String!
      $startKey: String!
      $endKey: String!
      $availabilityModeKey: String!
      $storefrontModeKey: String!
      $displayModeKey: String!
      $customMessageKey: String!
      $checkoutModeKey: String!
      $checkoutMessageKey: String!
      $noticeVariantKey: String!
      $noticeSettingsKey: String!
    ) {
      collections(
        first: $first
        last: $last
        after: $after
        before: $before
        query: $query
        sortKey: TITLE
      ) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        nodes {
          id
          title
          handle
          publishedOnPublication(publicationId: $publicationId)
          startDateMeta: metafield(namespace: $namespace, key: $startKey) {
            id
            value
          }
          endDateMeta: metafield(namespace: $namespace, key: $endKey) {
            id
            value
          }
          availabilityModeMeta: metafield(namespace: $namespace, key: $availabilityModeKey) {
            id
            value
          }
          storefrontModeMeta: metafield(namespace: $namespace, key: $storefrontModeKey) {
            id
            value
          }
          displayModeMeta: metafield(namespace: $namespace, key: $displayModeKey) {
            id
            value
          }
          customMessageMeta: metafield(namespace: $namespace, key: $customMessageKey) {
            id
            value
          }
          checkoutModeMeta: metafield(namespace: $namespace, key: $checkoutModeKey) {
            id
            value
          }
          checkoutMessageMeta: metafield(namespace: $namespace, key: $checkoutMessageKey) {
            id
            value
          }
          noticeVariantMeta: metafield(namespace: $namespace, key: $noticeVariantKey) {
            id
            value
          }
          noticeSettingsMeta: metafield(namespace: $namespace, key: $noticeSettingsKey) {
            id
            value
          }
        }
      }
    }`,
    { variables },
  );

  const payload = (await response.json()) as any;
  const raw = payload.data?.collections;

  const collections: CollectionRow[] = (raw?.nodes ?? []).map((node: any) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    isPublished: node.publishedOnPublication,
    startDateMeta: node.startDateMeta ?? null,
    endDateMeta: node.endDateMeta ?? null,
    availabilityModeMeta: node.availabilityModeMeta ?? null,
    storefrontModeMeta: node.storefrontModeMeta ?? null,
    displayModeMeta: node.displayModeMeta ?? null,
    customMessageMeta: node.customMessageMeta ?? null,
    checkoutModeMeta: node.checkoutModeMeta ?? null,
    checkoutMessageMeta: node.checkoutMessageMeta ?? null,
    noticeVariantMeta: node.noticeVariantMeta ?? null,
    noticeSettingsMeta: node.noticeSettingsMeta ?? null,
  }));

  return json<LoaderData>({
    collections,
    hasNextPage: raw?.pageInfo?.hasNextPage ?? false,
    hasPreviousPage: raw?.pageInfo?.hasPreviousPage ?? false,
    startCursor: raw?.pageInfo?.startCursor ?? null,
    endCursor: raw?.pageInfo?.endCursor ?? null,
    namespace,
    startKey,
    endKey,
    shopTimezone: shop.shopIanaTimezone ?? "UTC",
    publicationId,
    configMissing: false,
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;
  const shop = await shopRepository.findByShopDomain(session.shop);

  const namespace = shop?.metafieldNamespace ?? SCHEDULE_NAMESPACE_FALLBACK;
  const startKey = shop?.startDateKey ?? START_DATE_KEY_FALLBACK;
  const endKey = shop?.endDateKey ?? END_DATE_KEY_FALLBACK;
  const shopTimezone = shop?.shopIanaTimezone ?? "UTC";

  if (actionType === "setSchedule") {
    const collectionId = formData.get("collectionId") as string;
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const legacyDisplayMode = normalizeLegacyDisplayMode(formData.get("displayMode"));
    const availabilityMode = resolveSubmittedAvailabilityMode({
      rawAvailabilityMode: formData.get("availabilityMode"),
      legacyDisplayMode,
      startDate,
      endDate,
    });
    const storefrontMode = resolveSubmittedStorefrontMode({
      rawStorefrontMode: formData.get("storefrontMode"),
      legacyDisplayMode,
    });
    const customMessage = ((formData.get("customMessage") as string | null) ?? "").trim();
    const checkoutMode = normalizeCheckoutMode(formData.get("checkoutMode"));
    const checkoutMessage = ((formData.get("checkoutMessage") as string | null) ?? "").trim();
    const noticeVariant = normalizeNoticeVariant(formData.get("noticeVariant"));

    const validationError = validateDisplaySettings({
      availabilityMode,
      storefrontMode,
      checkoutMode,
      startDate,
      endDate,
      customMessage,
      checkoutMessage,
    });

    if (validationError) {
      return json({ ok: false, error: validationError }, { status: 400 });
    }

    try {
      const metafieldsToSet: Array<Record<string, string>> = [
        {
          ownerId: collectionId,
          namespace,
          key: AVAILABILITY_MODE_KEY,
          value: availabilityMode,
          type: "single_line_text_field",
        },
        {
          ownerId: collectionId,
          namespace,
          key: STOREFRONT_MODE_KEY,
          value: storefrontMode,
          type: "single_line_text_field",
        },
        {
          ownerId: collectionId,
          namespace,
          key: DISPLAY_MODE_KEY,
          value: storefrontModeToLegacyDisplayMode(storefrontMode),
          type: "single_line_text_field",
        },
        {
          ownerId: collectionId,
          namespace,
          key: CHECKOUT_MODE_KEY,
          value: checkoutMode,
          type: "single_line_text_field",
        },
        {
          ownerId: collectionId,
          namespace,
          key: NOTICE_VARIANT_KEY,
          value: noticeVariant,
          type: "single_line_text_field",
        },
      ];
      const metafieldsToDelete: Array<Record<string, string>> = [];

      if (storefrontMode === "message") {
        metafieldsToSet.push({
          ownerId: collectionId,
          namespace,
          key: CUSTOM_MESSAGE_KEY,
          value: customMessage,
          type: "multi_line_text_field",
        });
      } else {
        metafieldsToDelete.push({ ownerId: collectionId, namespace, key: CUSTOM_MESSAGE_KEY });
      }

      if (checkoutMode === "message" && checkoutMessage) {
        metafieldsToSet.push({
          ownerId: collectionId,
          namespace,
          key: CHECKOUT_MESSAGE_KEY,
          value: checkoutMessage,
          type: "multi_line_text_field",
        });
      } else {
        metafieldsToDelete.push({ ownerId: collectionId, namespace, key: CHECKOUT_MESSAGE_KEY });
      }

      if (availabilityMode === "none") {
        metafieldsToDelete.push(
          { ownerId: collectionId, namespace, key: startKey },
          { ownerId: collectionId, namespace, key: endKey },
        );
      } else {
        if (startDate) {
          metafieldsToSet.push({
            ownerId: collectionId,
            namespace,
            key: startKey,
            value: dateTimeInputToIsoString(startDate, shopTimezone),
            type: "date_time",
          });
        } else {
          metafieldsToDelete.push({ ownerId: collectionId, namespace, key: startKey });
        }

        if (endDate) {
          metafieldsToSet.push({
            ownerId: collectionId,
            namespace,
            key: endKey,
            value: dateTimeInputToIsoString(endDate, shopTimezone),
            type: "date_time",
          });
        } else {
          metafieldsToDelete.push({ ownerId: collectionId, namespace, key: endKey });
        }
      }

      const response = await admin.graphql(
        `#graphql
        mutation SetSchedule($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: metafieldsToSet,
          },
        },
      );

      const payload = await response.json();
      const graphqlError = getGraphqlErrorMessage(payload);
      if (graphqlError) {
        return json({ ok: false, error: graphqlError });
      }

      const userErrors = payload.data?.metafieldsSet?.userErrors ?? [];

      if (userErrors.length) {
        return json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
      }

      if (metafieldsToDelete.length) {
        const deleteResponse = await admin.graphql(
          `#graphql
          mutation DeleteDisplayScheduleMetafields($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
              deletedMetafields { key namespace ownerId }
              userErrors { field message }
            }
          }`,
          { variables: { metafields: metafieldsToDelete } },
        );

        const deletePayload = await deleteResponse.json();
        const deleteGraphqlError = getGraphqlErrorMessage(deletePayload);
        if (deleteGraphqlError) {
          return json({ ok: false, error: deleteGraphqlError });
        }

        const deleteErrors = deletePayload.data?.metafieldsDelete?.userErrors ?? [];
        if (deleteErrors.length) {
          return json({ ok: false, error: deleteErrors.map((e: any) => e.message).join("; ") });
        }
      }

      return json({ ok: true });
    } catch (err: any) {
      const message =
        err?.graphQLErrors?.[0]?.message ?? err?.message ?? "Shopify API error";
      return json({ ok: false, error: message });
    }
  }

  if (actionType === "clearSchedule") {
    const collectionId = formData.get("collectionId") as string;

    try {
      const res = await admin.graphql(
        `#graphql
        mutation ClearSchedule($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { key namespace ownerId }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              { ownerId: collectionId, namespace, key: startKey },
              { ownerId: collectionId, namespace, key: endKey },
              { ownerId: collectionId, namespace, key: AVAILABILITY_MODE_KEY },
            ],
          },
        },
      );

      const p = await res.json();
      const graphqlError = getGraphqlErrorMessage(p);
      if (graphqlError) {
        return json({ ok: false, error: graphqlError });
      }

      const errs = p.data?.metafieldsDelete?.userErrors ?? [];
      if (errs.length) {
        return json({ ok: false, error: errs.map((e: any) => e.message).join("; ") });
      }

      return json({ ok: true });
    } catch (err: any) {
      const message =
        err?.graphQLErrors?.[0]?.message ?? err?.message ?? "Shopify API error";
      return json({ ok: false, error: message });
    }
  }

  return json({ ok: false, error: "Unknown action" });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function getFormatterParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour") === "24" ? "00" : getPart("hour"),
    minute: getPart("minute"),
  };
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
    throw new Error(`Unsupported timezone offset "${offsetValue}" for ${timeZone}.`);
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

function dateTimeInputToIsoString(value: string, timeZone: string): string {
  if (!DATE_TIME_INPUT_PATTERN.test(value)) {
    throw new Error(`Invalid datetime-local value "${value}".`);
  }

  const [datePart, timePart] = value.split("T");
  const [yearText, monthText, dayText] = datePart.split("-");
  const [hourText, minuteText] = timePart.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid datetime-local value "${value}".`);
  }

  const instantMs = zonedDateTimeToInstantMs({
    timeZone,
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour,
    minute,
    second: 0,
  });

  return new Date(instantMs).toISOString();
}

function isoToDateTimeInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";

  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const { year, month, day, hour, minute } = getFormatterParts(parsed, timeZone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formatScheduleValue(value: string | null | undefined, timeZone: string): string {
  if (!value) return "—";

  if (DATE_PATTERN.test(value)) {
    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const { year, month, day, hour, minute } = getFormatterParts(parsed, timeZone);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getComparableScheduleInstant(
  value: string | null | undefined,
  timeZone: string,
  boundary: "start" | "end",
): number | null {
  if (!value) return null;
  if (DATE_PATTERN.test(value)) return getDayBoundaryInstantMs(value, timeZone, boundary);

  const instantMs = Date.parse(value);
  return Number.isFinite(instantMs) ? instantMs : null;
}

function getTodayInTimeZone(ianaTimezone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return year && month && day ? `${year}-${month}-${day}` : now.toISOString().split("T")[0];
}

function getGraphqlErrorMessage(payload: any): string | null {
  const messages = payload?.errors
    ?.map((error: { message?: string }) => error?.message)
    .filter(Boolean);

  if (!messages?.length) {
    return null;
  }

  return messages.join("; ");
}

function getCollectionAvailabilityMode(collection: CollectionRow): AvailabilityMode {
  const explicitMode = normalizeAvailabilityMode(collection.availabilityModeMeta?.value);
  if (collection.availabilityModeMeta?.value) return explicitMode;

  if (normalizeLegacyDisplayMode(collection.displayModeMeta?.value) === "message") {
    return "always_live";
  }

  return collection.startDateMeta || collection.endDateMeta ? "managed" : "none";
}

function getCollectionStorefrontMode(collection: CollectionRow): StorefrontMode {
  if (collection.storefrontModeMeta?.value) {
    return normalizeStorefrontMode(collection.storefrontModeMeta.value);
  }

  return legacyDisplayModeToStorefrontMode(collection.displayModeMeta?.value);
}

function getCollectionCheckoutMode(collection: CollectionRow): CheckoutMode {
  return normalizeCheckoutMode(collection.checkoutModeMeta?.value);
}

function getCollectionNoticeVariant(collection: CollectionRow): NoticeVariant {
  return normalizeNoticeVariant(collection.noticeVariantMeta?.value);
}

function resolveSubmittedAvailabilityMode(input: {
  rawAvailabilityMode: FormDataEntryValue | string | null | undefined;
  legacyDisplayMode: LegacyDisplayMode;
  startDate: string;
  endDate: string;
}): AvailabilityMode {
  if (input.rawAvailabilityMode != null) {
    const explicitMode = normalizeAvailabilityMode(input.rawAvailabilityMode);

    if (explicitMode === "none" && (input.startDate || input.endDate)) {
      return "always_live";
    }

    return explicitMode;
  }

  if (input.legacyDisplayMode === "message" || input.legacyDisplayMode === "countdown") {
    return "always_live";
  }

  return input.startDate || input.endDate ? "managed" : "none";
}

function resolveSubmittedStorefrontMode(input: {
  rawStorefrontMode: FormDataEntryValue | string | null | undefined;
  legacyDisplayMode: LegacyDisplayMode;
}): StorefrontMode {
  if (input.rawStorefrontMode != null) {
    return normalizeStorefrontMode(input.rawStorefrontMode);
  }

  return legacyDisplayModeToStorefrontMode(input.legacyDisplayMode);
}

function validateDisplaySettings(input: {
  availabilityMode: AvailabilityMode;
  storefrontMode: StorefrontMode;
  checkoutMode: CheckoutMode;
  startDate: string;
  endDate: string;
  customMessage: string;
  checkoutMessage: string;
}): string | null {
  if (input.availabilityMode === "managed" && (!input.startDate || !input.endDate)) {
    return "Managed scheduling requires both start and end dates.";
  }

  if (input.startDate && input.endDate && input.endDate <= input.startDate) {
    return "End date must be after start date.";
  }

  if (input.storefrontMode === "countdown_to_end" && !input.endDate) {
    return "Countdown to order deadline requires an end date.";
  }

  if (input.storefrontMode === "message" && !input.customMessage.trim()) {
    return "Storefront custom message requires message text.";
  }

  if (input.checkoutMode === "countdown_to_end" && !input.endDate) {
    return "Checkout countdown requires an end date.";
  }

  if (
    input.checkoutMode === "message" &&
    !input.checkoutMessage.trim() &&
    (input.storefrontMode !== "message" || !input.customMessage.trim())
  ) {
    return "Checkout custom message requires checkout message text or a storefront custom message fallback.";
  }

  return null;
}

function previewMessage(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function scheduleStatus(
  startMeta: MetafieldNode,
  endMeta: MetafieldNode,
  shopTimezone: string,
): "active" | "expired" | "pending" | "none" {
  if (!startMeta || !endMeta) return "none";

  if (!DATE_PATTERN.test(startMeta.value) || !DATE_PATTERN.test(endMeta.value)) {
    const nowInstant = Date.now();
    const startInstant = getComparableScheduleInstant(startMeta.value, shopTimezone, "start");
    const endInstant = getComparableScheduleInstant(endMeta.value, shopTimezone, "end");

    if (startInstant == null || endInstant == null) {
      return "none";
    }

    if (nowInstant >= startInstant && nowInstant <= endInstant) return "active";
    if (nowInstant > endInstant) return "expired";
    return "pending";
  }

  const today = getTodayInTimeZone(shopTimezone);
  if (today >= startMeta.value && today <= endMeta.value) return "active";
  if (today > endMeta.value) return "expired";
  return "pending";
}

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "critical", label: "Expired" },
  pending: { tone: "attention", label: "Pending" },
  none: { tone: "info", label: "No schedule" },
};

const AVAILABILITY_BADGE: Record<AvailabilityMode, { tone: any; label: string }> = {
  managed: { tone: "success", label: "Managed" },
  always_live: { tone: "info", label: "Always live" },
  none: { tone: "enabled", label: "No automation" },
};

const STOREFRONT_BADGE: Record<StorefrontMode, { tone: any; label: string }> = {
  none: { tone: "enabled", label: "Hidden" },
  countdown_to_end: { tone: "attention", label: "Countdown" },
  message: { tone: "success", label: "Message" },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function CollectionsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [editingCollection, setEditingCollection] = useState<CollectionRow | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [availabilityMode, setAvailabilityMode] = useState<AvailabilityMode>("none");
  const [storefrontMode, setStorefrontMode] = useState<StorefrontMode>("none");
  const [customMessage, setCustomMessage] = useState("");
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("inherit_storefront");
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [noticeVariant, setNoticeVariant] = useState<NoticeVariant>("theme_native");
  const [searchValue, setSearchValue] = useState(searchParams.get("q") ?? "");

  const openEdit = useCallback((col: CollectionRow) => {
    setEditingCollection(col);
    setStartDate(isoToDateTimeInput(col.startDateMeta?.value, data.shopTimezone));
    setEndDate(isoToDateTimeInput(col.endDateMeta?.value, data.shopTimezone));
    setAvailabilityMode(getCollectionAvailabilityMode(col));
    setStorefrontMode(getCollectionStorefrontMode(col));
    setCustomMessage(col.customMessageMeta?.value ?? "");
    setCheckoutMode(getCollectionCheckoutMode(col));
    setCheckoutMessage(col.checkoutMessageMeta?.value ?? "");
    setNoticeVariant(getCollectionNoticeVariant(col));
  }, [data.shopTimezone]);

  const closeEdit = useCallback(() => {
    setEditingCollection(null);
    setStartDate("");
    setEndDate("");
    setAvailabilityMode("none");
    setStorefrontMode("none");
    setCustomMessage("");
    setCheckoutMode("inherit_storefront");
    setCheckoutMessage("");
    setNoticeVariant("theme_native");
  }, []);

  const validationError = validateDisplaySettings({
    availabilityMode,
    storefrontMode,
    checkoutMode,
    startDate,
    endDate,
    customMessage,
    checkoutMessage,
  });

  const handleSave = useCallback(() => {
    if (!editingCollection) return;
    fetcher.submit(
      {
        actionType: "setSchedule",
        collectionId: editingCollection.id,
        startDate,
        endDate,
        availabilityMode,
        storefrontMode,
        customMessage,
        checkoutMode,
        checkoutMessage,
        noticeVariant,
      },
      { method: "post" },
    );
    closeEdit();
  }, [editingCollection, startDate, endDate, availabilityMode, storefrontMode, customMessage, checkoutMode, checkoutMessage, noticeVariant, fetcher, closeEdit]);

  const handleClear = useCallback(
    (col: CollectionRow) => {
      fetcher.submit(
        { actionType: "clearSchedule", collectionId: col.id },
        { method: "post" },
      );
    },
    [fetcher],
  );

  const handleSearch = useCallback(() => {
    const p = new URLSearchParams(searchParams);
    if (searchValue) {
      p.set("q", searchValue);
    } else {
      p.delete("q");
    }
    p.delete("after");
    p.delete("before");
    setSearchParams(p);
  }, [searchValue, searchParams, setSearchParams]);

  const goNext = useCallback(() => {
    const p = new URLSearchParams(searchParams);
    p.set("after", data.endCursor ?? "");
    p.delete("before");
    setSearchParams(p);
  }, [data.endCursor, searchParams, setSearchParams]);

  const goPrev = useCallback(() => {
    const p = new URLSearchParams(searchParams);
    p.set("before", data.startCursor ?? "");
    p.delete("after");
    setSearchParams(p);
  }, [data.startCursor, searchParams, setSearchParams]);

  if (data.configMissing) {
    return (
      <Page title="Collections">
        <Banner tone="warning" title="Publication not configured">
          <Text as="p">
            Go to <strong>Settings</strong> and select a target publication before managing
            collection schedules.
          </Text>
        </Banner>
      </Page>
    );
  }

  const isSaving = fetcher.state !== "idle";
  const fetcherError = fetcher.data?.ok === false ? fetcher.data.error : null;

  return (
    <Page
      title="Collections"
      subtitle={`Namespace: ${data.namespace} · Keys: ${data.startKey} / ${data.endKey}`}
    >
      <Layout>
        {fetcherError && (
          <Layout.Section>
            <Banner tone="critical" title="Error">
              <Text as="p">{fetcherError}</Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {/* Search */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSearch();
                }}
              >
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1, maxWidth: 360 }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="Search collections…"
                      value={searchValue}
                      onChange={setSearchValue}
                      autoComplete="off"
                      connectedRight={
                        <Button submit>Search</Button>
                      }
                    />
                  </div>
                </InlineStack>
              </form>

              <Divider />

              {/* Table */}
              {data.collections.length === 0 ? (
                <EmptyState
                  heading="No collections found"
                  image=""
                >
                  <BlockStack gap="200">
                    <Text as="p">
                      We couldn&apos;t find any collections. This might be because they are not published to your selected Sales Channel.
                    </Text>
                    <Text as="p" tone="subdued">
                      Current Target Publication ID: {data.publicationId}
                    </Text>
                  </BlockStack>
                </EmptyState>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {[
                          "Collection",
                          "Availability",
                          "Schedule Window",
                          "Storefront Notice",
                          "Published",
                          "",
                        ].map(
                          (h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: "left",
                                padding: "8px 12px",
                                borderBottom: "1px solid var(--p-color-border)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                                {h}
                              </Text>
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.collections.map((col) => {
                        const status = scheduleStatus(
                          col.startDateMeta,
                          col.endDateMeta,
                          data.shopTimezone,
                        );
                        const badge = STATUS_BADGE[status];
                        const rowAvailabilityMode = getCollectionAvailabilityMode(col);
                        const rowStorefrontMode = getCollectionStorefrontMode(col);
                        const availabilityBadge = AVAILABILITY_BADGE[rowAvailabilityMode];
                        const storefrontBadge = STOREFRONT_BADGE[rowStorefrontMode];
                        return (
                          <tr key={col.id} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                            <td style={{ padding: "10px 12px" }}>
                              <BlockStack gap="050">
                                <Text as="span" variant="bodyMd" fontWeight="medium">
                                  {col.title}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {col.handle}
                                </Text>
                              </BlockStack>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <Badge tone={availabilityBadge.tone}>{availabilityBadge.label}</Badge>
                            </td>
                            <td style={{ padding: "10px 12px", minWidth: 260 }}>
                              <BlockStack gap="050">
                                <InlineStack gap="100" blockAlign="center">
                                  <Badge tone={badge.tone}>{badge.label}</Badge>
                                  <Text as="span" variant="bodySm">
                                    {formatScheduleValue(col.startDateMeta?.value, data.shopTimezone)}
                                    {" - "}
                                    {formatScheduleValue(col.endDateMeta?.value, data.shopTimezone)}
                                  </Text>
                                </InlineStack>
                              </BlockStack>
                            </td>
                            <td style={{ padding: "10px 12px", minWidth: 240 }}>
                              <BlockStack gap="050">
                                <Badge tone={storefrontBadge.tone}>{storefrontBadge.label}</Badge>
                                {rowStorefrontMode === "message" && (
                                  <Text as="span" variant="bodySm">
                                    {previewMessage(col.customMessageMeta?.value)}
                                  </Text>
                                )}
                              </BlockStack>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <Badge tone={col.isPublished ? "success" : "enabled"}>
                                {col.isPublished ? "Yes" : "No"}
                              </Badge>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <InlineStack gap="200" wrap={false}>
                                <Button
                                  size="slim"
                                  onClick={() => openEdit(col)}
                                  loading={isSaving}
                                >
                                  Edit
                                </Button>
                                {(col.startDateMeta || col.endDateMeta) && (
                                  <Button
                                    size="slim"
                                    tone="critical"
                                    variant="plain"
                                    loading={isSaving}
                                    onClick={() => handleClear(col)}
                                  >
                                    Clear availability
                                  </Button>
                                )}
                              </InlineStack>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {(data.hasNextPage || data.hasPreviousPage) && (
                <Box paddingBlockStart="300">
                  <Pagination
                    hasPrevious={data.hasPreviousPage}
                    hasNext={data.hasNextPage}
                    onPrevious={goPrev}
                    onNext={goNext}
                  />
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Edit Modal */}
      <Modal
        open={editingCollection !== null}
        onClose={closeEdit}
        title={editingCollection?.title ?? "Edit Schedule"}
        primaryAction={{
          content: "Save",
          onAction: handleSave,
          disabled: !!validationError,
          loading: isSaving,
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeEdit }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Date and time are edited in the shop&apos;s timezone ({data.shopTimezone}).
            </Text>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Availability
              </Text>
              <Select
                label="Schedule / availability behavior"
                options={AVAILABILITY_MODE_OPTIONS}
                value={availabilityMode}
                onChange={(value) => {
                  const nextMode = normalizeAvailabilityMode(value);
                  setAvailabilityMode(nextMode);
                  if (nextMode === "none") {
                    setStartDate("");
                    setEndDate("");
                    if (storefrontMode === "countdown_to_end") {
                      setStorefrontMode("none");
                    }
                  }
                }}
                helpText="Dates control product automation only when Managed by Scheduler is selected."
              />
            </BlockStack>
            <InlineGrid columns={2} gap="400">
              <TextField
                label="Start date and time"
                type="datetime-local"
                value={startDate}
                onChange={setStartDate}
                autoComplete="off"
                disabled={availabilityMode === "none"}
              />
              <TextField
                label="End date and time"
                type="datetime-local"
                value={endDate}
                onChange={setEndDate}
                autoComplete="off"
                disabled={availabilityMode === "none"}
              />
            </InlineGrid>
            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Storefront notice
              </Text>
            <Select
                label="Notice shown on collection and product pages"
                options={STOREFRONT_MODE_OPTIONS}
                value={storefrontMode}
                onChange={(value) => {
                  const nextMode = normalizeStorefrontMode(value);
                  setStorefrontMode(nextMode);
                  if (nextMode === "countdown_to_end" && availabilityMode === "none") {
                    setAvailabilityMode("always_live");
                  }
                }}
                helpText="Countdown uses the end date as the order deadline. It does not change publication or product status."
            />
              {storefrontMode === "message" && (
              <TextField
                label="Custom message"
                value={customMessage}
                onChange={setCustomMessage}
                autoComplete="off"
                multiline={4}
                placeholder="ALL ORDERS PLACED WILL BE DELIVERED 5-6 WEEKS LATER"
              />
            )}
            </BlockStack>
            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Checkout notice
              </Text>
              <Text as="p" tone="subdued">
                Checkout display requires Shopify Plus checkout extensibility. These settings do
                not affect storefront notices or product availability.
              </Text>
              <Select
                label="Notice shown in checkout"
                options={CHECKOUT_MODE_OPTIONS}
                value={checkoutMode}
                onChange={(value) => setCheckoutMode(normalizeCheckoutMode(value))}
                helpText="Inherit uses the storefront notice mode. Checkout settings never change product automation."
              />
              {checkoutMode === "message" && (
                <TextField
                  label="Checkout message"
                  value={checkoutMessage}
                  onChange={setCheckoutMessage}
                  autoComplete="off"
                  multiline={4}
                  placeholder="Add checkout-specific delivery or order deadline copy"
                  helpText="Leave blank to use the storefront custom message when one is available."
                />
              )}
            </BlockStack>
            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Storefront style
              </Text>
              <Select
                label="Default notice variant"
                options={NOTICE_VARIANT_OPTIONS}
                value={noticeVariant}
                onChange={(value) => setNoticeVariant(normalizeNoticeVariant(value))}
                helpText="Theme app blocks can use this as the default storefront notice style."
              />
            </BlockStack>
            {validationError && (
              <Banner tone="critical">
                <Text as="p">{validationError}</Text>
              </Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
