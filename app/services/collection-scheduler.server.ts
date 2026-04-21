import { shopifyAdminGraphqlRequest, ShopifyAdminGraphqlError } from "./shopify-admin.server";

export type PublicationSummary = {
  id: string;
  name: string | null;
};

export type ScheduledCollection = {
  id: string;
  title: string;
  startDateValue: string | null;
  endDateValue: string | null;
  isPublishedOnTargetPublication: boolean;
};

export type GetScheduledCollectionsOptions = {
  publicationId: string;
  metafieldNamespace: string;
  startDateKey: string;
  endDateKey: string;
  cursor?: string | null;
  pageSize?: number;
};

export type ScheduledCollectionsPage = {
  collections: ScheduledCollection[];
  hasNextPage: boolean;
  nextCursor: string | null;
};

export type SyncCollectionVisibilityResult = {
  action: "publish" | "unpublish" | "skip";
  previousState: boolean;
  currentState: boolean;
  mutated: boolean;
  dryRun: boolean;
};

type GetPublicationsResponse = {
  publications: {
    nodes: Array<{
      id: string;
      name?: string | null;
    }>;
  };
};

type GetShopTimezoneResponse = {
  shop: {
    ianaTimezone: string;
  };
};

type GetScheduledCollectionsResponse = {
  collections: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: Array<{
      node: {
        id: string;
        title: string;
        publishedOnPublication: boolean;
        startDate: {
          value: string;
        } | null;
        endDate: {
          value: string;
        } | null;
      };
    }>;
  };
};

type GetCollectionStateResponse = {
  node: {
    id: string;
    publishedOnPublication: boolean;
  } | null;
};

type PublishMutationResponse = {
  publishablePublish: {
    userErrors: Array<{
      field?: string[] | null;
      message: string;
    }>;
  };
};

type UnpublishMutationResponse = {
  publishableUnpublish: {
    userErrors: Array<{
      field?: string[] | null;
      message: string;
    }>;
  };
};

function formatMutationErrors(errors: Array<{ field?: string[] | null; message: string }>): string {
  return errors
    .map((error) => {
      const path = error.field?.length ? `${error.field.join(".")}: ` : "";
      return `${path}${error.message}`;
    })
    .join("; ");
}

export async function getShopPublications(shopDomain: string, first = 20): Promise<PublicationSummary[]> {
  const data = await shopifyAdminGraphqlRequest<GetPublicationsResponse, { first: number }>(
    shopDomain,
    `#graphql
      query GetShopPublications($first: Int!) {
        publications(first: $first) {
          nodes {
            id
            name
          }
        }
      }
    `,
    { first },
  );

  return data.publications.nodes.map((publication) => ({
    id: publication.id,
    name: publication.name ?? null,
  }));
}

export async function getShopIanaTimezone(shopDomain: string): Promise<string> {
  const data = await shopifyAdminGraphqlRequest<GetShopTimezoneResponse>(shopDomain, `#graphql
    query GetShopTimezone {
      shop {
        ianaTimezone
      }
    }
  `);

  return data.shop.ianaTimezone;
}

export async function getScheduledCollections(
  shopDomain: string,
  options: GetScheduledCollectionsOptions,
): Promise<ScheduledCollectionsPage> {
  const searchQuery = `metafields.${options.metafieldNamespace}.${options.startDateKey}:* AND metafields.${options.metafieldNamespace}.${options.endDateKey}:*`;

  const data = await shopifyAdminGraphqlRequest<
    GetScheduledCollectionsResponse,
    {
      after?: string | null;
      first: number;
      query: string;
      publicationId: string;
      namespace: string;
      startKey: string;
      endKey: string;
    }
  >(
    shopDomain,
    `#graphql
      query GetScheduledCollections(
        $after: String
        $first: Int!
        $query: String!
        $publicationId: ID!
        $namespace: String!
        $startKey: String!
        $endKey: String!
      ) {
        collections(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              publishedOnPublication(publicationId: $publicationId)
              startDate: metafield(namespace: $namespace, key: $startKey) {
                value
              }
              endDate: metafield(namespace: $namespace, key: $endKey) {
                value
              }
            }
          }
        }
      }
    `,
    {
      after: options.cursor ?? null,
      first: options.pageSize ?? 100,
      query: searchQuery,
      publicationId: options.publicationId,
      namespace: options.metafieldNamespace,
      startKey: options.startDateKey,
      endKey: options.endDateKey,
    },
  );

  return {
    collections: data.collections.edges.map(({ node }) => ({
      id: node.id,
      title: node.title,
      startDateValue: node.startDate?.value ?? null,
      endDateValue: node.endDate?.value ?? null,
      isPublishedOnTargetPublication: node.publishedOnPublication,
    })),
    hasNextPage: data.collections.pageInfo.hasNextPage,
    nextCursor: data.collections.pageInfo.endCursor,
  };
}

async function getCollectionPublicationState(
  shopDomain: string,
  collectionGid: string,
  publicationGid: string,
): Promise<boolean> {
  const data = await shopifyAdminGraphqlRequest<
    GetCollectionStateResponse,
    { id: string; publicationId: string }
  >(
    shopDomain,
    `#graphql
      query GetCollectionPublicationState($id: ID!, $publicationId: ID!) {
        node(id: $id) {
          ... on Collection {
            id
            publishedOnPublication(publicationId: $publicationId)
          }
        }
      }
    `,
    {
      id: collectionGid,
      publicationId: publicationGid,
    },
  );

  if (!data.node) {
    throw new ShopifyAdminGraphqlError(`Collection ${collectionGid} was not found.`, shopDomain, {
      collectionGid,
    });
  }

  return data.node.publishedOnPublication;
}

export async function syncCollectionVisibility(
  shopDomain: string,
  collectionGid: string,
  publicationGid: string,
  shouldBePublished: boolean,
  options?: { dryRun?: boolean },
): Promise<SyncCollectionVisibilityResult> {
  const previousState = await getCollectionPublicationState(shopDomain, collectionGid, publicationGid);

  if (previousState === shouldBePublished) {
    return {
      action: "skip",
      previousState,
      currentState: previousState,
      mutated: false,
      dryRun: options?.dryRun ?? false,
    };
  }

  if (options?.dryRun) {
    return {
      action: shouldBePublished ? "publish" : "unpublish",
      previousState,
      currentState: previousState,
      mutated: false,
      dryRun: true,
    };
  }

  if (shouldBePublished) {
    const data = await shopifyAdminGraphqlRequest<
      PublishMutationResponse,
      { collectionId: string; input: Array<{ publicationId: string }> }
    >(
      shopDomain,
      `#graphql
        mutation PublishCollection($collectionId: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $collectionId, input: $input) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        collectionId: collectionGid,
        input: [{ publicationId: publicationGid }],
      },
    );

    if (data.publishablePublish.userErrors.length) {
      throw new ShopifyAdminGraphqlError(
        formatMutationErrors(data.publishablePublish.userErrors),
        shopDomain,
        { collectionGid, publicationGid },
      );
    }

    return {
      action: "publish",
      previousState,
      currentState: true,
      mutated: true,
      dryRun: false,
    };
  }

  const data = await shopifyAdminGraphqlRequest<
    UnpublishMutationResponse,
    { collectionId: string; input: Array<{ publicationId: string }> }
  >(
    shopDomain,
    `#graphql
      mutation UnpublishCollection($collectionId: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $collectionId, input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      collectionId: collectionGid,
      input: [{ publicationId: publicationGid }],
    },
  );

  if (data.publishableUnpublish.userErrors.length) {
    throw new ShopifyAdminGraphqlError(
      formatMutationErrors(data.publishableUnpublish.userErrors),
      shopDomain,
      { collectionGid, publicationGid },
    );
  }

  return {
    action: "unpublish",
    previousState,
    currentState: false,
    mutated: true,
    dryRun: false,
  };
}
