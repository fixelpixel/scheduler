import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  emptyStorefrontSchedule,
  getStorefrontSchedule,
  isValidShopDomain,
} from "../services/storefront-schedule.server";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CACHE_HEADERS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const collectionHandle = cleanHandle(url.searchParams.get("collectionHandle"));
  const productHandle = cleanHandle(url.searchParams.get("productHandle"));

  if (!isValidShopDomain(shop)) {
    return json(emptyStorefrontSchedule(), { headers: CACHE_HEADERS });
  }

  try {
    const payload = await getStorefrontSchedule({
      shop,
      collectionHandle,
      productHandle,
    });

    return json(payload, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error("[StorefrontSchedule] Failed to resolve display settings.", {
      shop,
      collectionHandle,
      productHandle,
      error: error instanceof Error ? error.message : String(error),
    });

    return json(emptyStorefrontSchedule(), { headers: CACHE_HEADERS });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CACHE_HEADERS });
  }

  return json(emptyStorefrontSchedule(), { status: 405, headers: CACHE_HEADERS });
};

function cleanHandle(value: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9-]*$/i.test(trimmed) ? trimmed : null;
}
