import { json, type ActionFunctionArgs } from "@remix-run/node";
import {
  emptyCheckoutSchedule,
  getCheckoutSchedule,
  isValidShopDomain,
  isValidProductGid,
  isValidProductVariantGid,
} from "../services/checkout-schedule.server";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_CHECKOUT_BODY_BYTES = 8192;
const MAX_GIDS_PER_REQUEST = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 600;
const checkoutRateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export const loader = async () =>
  json(emptyCheckoutSchedule(), { status: 405, headers: CACHE_HEADERS });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CACHE_HEADERS });
  }

  if (request.method !== "POST") {
    return json(emptyCheckoutSchedule(), { status: 405, headers: CACHE_HEADERS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!isValidShopDomain(shop)) {
    return json(emptyCheckoutSchedule(), { headers: CACHE_HEADERS });
  }

  if (isRateLimited(request, shop)) {
    return json(emptyCheckoutSchedule(), { status: 429, headers: CACHE_HEADERS });
  }

  const body = await parseBoundedJsonBody(request);
  if (body === null) {
    return json(emptyCheckoutSchedule(), { headers: CACHE_HEADERS });
  }

  const productIds = parseBodyGidList(body, "productIds", isValidProductGid);
  const variantIds = parseBodyGidList(body, "variantIds", isValidProductVariantGid);

  if (productIds === null || variantIds === null) {
    return json(emptyCheckoutSchedule(), { headers: CACHE_HEADERS });
  }

  if (productIds.length === 0 && variantIds.length === 0) {
    return json(emptyCheckoutSchedule(), { headers: CACHE_HEADERS });
  }

  try {
    const payload = await getCheckoutSchedule({
      shop,
      productIds,
      variantIds,
    });

    return json(payload, { headers: CACHE_HEADERS });
  } catch {
    console.error("[CheckoutSchedule] Failed to resolve display settings.", {
      shop,
      code: "checkout_schedule_resolution_failed",
    });

    return json(emptyCheckoutSchedule(), { headers: CACHE_HEADERS });
  }
};

function isRateLimited(request: Request, shop: string): boolean {
  const now = Date.now();
  const clientKey = getClientKey(request);
  const key = `${shop}:${clientKey}`;
  const bucket = checkoutRateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    checkoutRateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    pruneExpiredRateLimitBuckets(now);
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_REQUESTS;
}

function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    forwardedFor ||
    "unknown"
  );
}

function pruneExpiredRateLimitBuckets(now: number) {
  if (checkoutRateLimitBuckets.size < 1_000) return;

  for (const [key, bucket] of checkoutRateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      checkoutRateLimitBuckets.delete(key);
    }
  }
}

async function parseBoundedJsonBody(request: Request): Promise<unknown | null> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength > MAX_CHECKOUT_BODY_BYTES) {
      return null;
    }
  }

  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_CHECKOUT_BODY_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    const text = chunks.join("");
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseBodyGidList(
  body: unknown,
  key: "productIds" | "variantIds",
  isValid: (id: string) => boolean,
): string[] | null {
  if (!isPlainRecord(body)) return [];

  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_GIDS_PER_REQUEST) return null;

  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length !== value.length || !ids.every(isValid)) return null;

  return [...new Set(ids)];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
