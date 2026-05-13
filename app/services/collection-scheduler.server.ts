import { shopifyAdminGraphqlRequest } from "./shopify-admin.server";
import { AVAILABILITY_MODE_KEY, DISPLAY_MODE_KEY } from "./schedule-contract";

export type ScheduledCollection = {
  id: string;
  title: string;
  startDateValue: string | null;
  endDateValue: string | null;
  availabilityModeValue: string | null;
  displayModeValue: string | null;
  isPublishedOnTargetPublication: boolean;
};

export type GetScheduledCollectionsResult = {
  collections: ScheduledCollection[];
  hasNextPage: boolean;
  nextCursor: string | null;
};

export type SyncResult = {
  action: "PUBLISH" | "UNPUBLISH" | "SKIP";
  previousState: boolean;
  dryRun: boolean;
};

type ProductStatusNode = {
  id: string;
  status: string;
};

type ProductsInCollectionData = {
  collection?: {
    products?: {
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
      nodes?: ProductStatusNode[];
    };
  };
};

type ProductUpdateData = {
  productUpdate?: {
    userErrors?: Array<{
      field?: string[] | null;
      message?: string;
    }>;
  };
};

export async function getShopIanaTimezone(shopDomain: string): Promise<string> {
  const data = await shopifyAdminGraphqlRequest<any, any>(
    shopDomain,
    `#graphql
    query GetShopTimezone {
      shop {
        ianaTimezone
      }
    }
  `,
    {},
  );

  return data.shop?.ianaTimezone || "UTC";
}

const GET_COLLECTIONS_QUERY = `#graphql
  query GetCollections(
    $first: Int!
    $after: String
    $startNamespace: String!
    $startKey: String!
    $endNamespace: String!
    $endKey: String!
    $availabilityModeKey: String!
    $displayModeKey: String!
  ) {
    collections(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        startDate: metafield(namespace: $startNamespace, key: $startKey) { value }
        endDate: metafield(namespace: $endNamespace, key: $endKey) { value }
        availabilityMode: metafield(namespace: $startNamespace, key: $availabilityModeKey) { value }
        displayMode: metafield(namespace: $startNamespace, key: $displayModeKey) { value }
        resourcePublications(first: 10) {
          nodes {
            publication { id name }
            isPublished
          }
        }
      }
    }
  }
`;

export async function getScheduledCollections(
  shopDomain: string,
  options: {
    publicationId: string;
    metafieldNamespace: string;
    startDateKey: string;
    endDateKey: string;
    cursor?: string | null;
    pageSize?: number;
  },
): Promise<GetScheduledCollectionsResult> {
  const variables = {
    first: options.pageSize || 50,
    after: options.cursor || null,
    startNamespace: options.metafieldNamespace,
    startKey: options.startDateKey,
    endNamespace: options.metafieldNamespace,
    endKey: options.endDateKey,
    availabilityModeKey: AVAILABILITY_MODE_KEY,
    displayModeKey: DISPLAY_MODE_KEY,
  };

  const data = await shopifyAdminGraphqlRequest<any, any>(
    shopDomain,
    GET_COLLECTIONS_QUERY,
    variables,
  );

  const rawCollections = data.collections?.nodes || [];
  const pageInfo = data.collections?.pageInfo;

  const collections = rawCollections.map((node: any) => {
    const publication = node.resourcePublications.nodes.find(
      (p: any) => p.publication.id === options.publicationId,
    );

    return {
      id: node.id,
      title: node.title,
      startDateValue: node.startDate?.value || null,
      endDateValue: node.endDate?.value || null,
      availabilityModeValue: node.availabilityMode?.value || null,
      displayModeValue: node.displayMode?.value || null,
      isPublishedOnTargetPublication: publication?.isPublished || false,
    };
  });

  return {
    collections,
    hasNextPage: pageInfo?.hasNextPage || false,
    nextCursor: pageInfo?.endCursor || null,
  };
}

export async function syncCollectionVisibility(
  shopDomain: string,
  collectionGid: string,
  publicationGid: string,
  shouldBePublished: boolean,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const data = await shopifyAdminGraphqlRequest<any, { id: string }>(
    shopDomain,
    `#graphql
    query GetCollectionStatus($id: ID!) {
      collection(id: $id) {
        resourcePublications(first: 100) {
          nodes {
            publication { id }
            isPublished
          }
        }
      }
    }
  `,
    { id: collectionGid },
  );

  const publication = data.collection?.resourcePublications.nodes.find(
    (p: any) => p.publication.id === publicationGid,
  );

  const previousState = publication?.isPublished || false;

  const changedCount = await syncProductsStatusInCollection(
    shopDomain,
    collectionGid,
    shouldBePublished,
    { dryRun: options.dryRun },
  );

  if (changedCount === 0) {
    return {
      action: "SKIP",
      previousState,
      dryRun: options.dryRun ?? false,
    };
  }

  if (options.dryRun) {
    return {
      action: shouldBePublished ? "PUBLISH" : "UNPUBLISH",
      previousState,
      dryRun: true,
    };
  }

  return {
    action: shouldBePublished ? "PUBLISH" : "UNPUBLISH",
    previousState,
    dryRun: false,
  };
}

async function syncProductsStatusInCollection(
  shopDomain: string,
  collectionGid: string,
  shouldBeActive: boolean,
  options: { dryRun?: boolean } = {},
): Promise<number> {
  const targetStatus = shouldBeActive ? "ACTIVE" : "DRAFT";
  const productsToUpdate: ProductStatusNode[] = [];
  let cursor: string | null = null;

  do {
    const data: ProductsInCollectionData = await shopifyAdminGraphqlRequest<
      ProductsInCollectionData,
      { id: string; after: string | null }
    >(
      shopDomain,
      `#graphql
      query GetProductsInCollection($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              status
            }
          }
        }
      }
    `,
      { id: collectionGid, after: cursor },
    );

    const products = data.collection?.products?.nodes || [];
    productsToUpdate.push(...products.filter((product) => product.status !== targetStatus));

    const pageInfo = data.collection?.products?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor ?? null : null;
  } while (cursor);

  if (productsToUpdate.length === 0) return 0;

  console.log("[CollectionScheduler] Updating product statuses.", {
    shopDomain,
    productCount: productsToUpdate.length,
    targetStatus,
    dryRun: options.dryRun ?? false,
  });

  if (options.dryRun) {
    return productsToUpdate.length;
  }

  // Process in chunks of 5 to balance speed and rate limits
  const chunkSize = 5;
  for (let i = 0; i < productsToUpdate.length; i += chunkSize) {
    const chunk = productsToUpdate.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map(async (product) => {
        const data: ProductUpdateData = await shopifyAdminGraphqlRequest<
          ProductUpdateData,
          { id: string; status: string }
        >(
          shopDomain,
          `#graphql
          mutation UpdateProductStatus($id: ID!, $status: ProductStatus!) {
            productUpdate(input: { id: $id, status: $status }) {
              userErrors { field message }
            }
          }
        }
        `,
          { id: product.id, status: targetStatus },
        );

        const userErrors = data.productUpdate?.userErrors || [];
        if (userErrors.length > 0) {
          const details = userErrors
            .map((error) => {
              const field = error.field?.join(".") || "unknown_field";
              const message = error.message || "Unknown user error";
              return `${field}: ${message}`;
            })
            .join("; ");
          throw new Error(`Shopify rejected a product status update: ${details}`);
        }
      }),
    );
  }

  return productsToUpdate.length;
}
