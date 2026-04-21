import "@shopify/shopify-app-remix/adapters/node";

import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";
import { shopRepository } from "./repositories/shop.repository.server";

export const SHOPIFY_API_VERSION = ApiVersion.January25;

type InstallBootstrapResponse = {
  data?: {
    shop?: {
      ianaTimezone?: string | null;
    } | null;
    publications?: {
      nodes?: Array<{
        id: string;
        name?: string | null;
      }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

async function bootstrapShopConfiguration(session: { accessToken?: string | null; shop: string }) {
  if (!session.accessToken) {
    return;
  }

  const response = await fetch(`https://${session.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query InstallBootstrap($first: Int!) {
          shop {
            ianaTimezone
          }
          publications(first: $first) {
            nodes {
              id
              name
            }
          }
        }
      `,
      variables: { first: 20 },
    }),
  });

  if (!response.ok) {
    return;
  }

  const payload = (await response.json()) as InstallBootstrapResponse;

  if (payload.errors?.length) {
    return;
  }

  const publications = payload.data?.publications?.nodes ?? [];
  const timezone = payload.data?.shop?.ianaTimezone ?? null;
  const existingShop = await shopRepository.findByShopDomain(session.shop);
  const bestEffortPublication =
    publications.find((publication) => publication.name?.toLowerCase() === "online store") ??
    publications[0] ??
    null;

  await shopRepository.upsertConfig({
    shopDomain: session.shop,
    shopIanaTimezone: timezone,
    targetPublicationId: existingShop?.targetPublicationId ?? bestEffortPublication?.id ?? null,
    isActive: true,
  });
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET ?? "",
  apiVersion: SHOPIFY_API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL ?? "",
  authPathPrefix: "/auth",
  distribution: AppDistribution.AppStore,
  sessionStorage: new PrismaSessionStorage(prisma),
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] } : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      await bootstrapShopConfiguration(session);
    },
  },
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export const unauthenticated = shopify.unauthenticated;
