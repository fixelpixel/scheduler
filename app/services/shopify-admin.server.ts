import { unauthenticated } from "../shopify.server";

const DEFAULT_MAX_RETRIES = 6;
const BASE_RETRY_DELAY_MS = 1_000;

type GraphqlError = {
  message: string;
  extensions?: {
    code?: string;
  };
};

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: GraphqlError[];
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable: number;
        maximumAvailable: number;
        restoreRate: number;
      };
    };
  };
};

export class ShopifyAdminGraphqlError extends Error {
  constructor(
    message: string,
    readonly shopDomain: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyAdminGraphqlError";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(errors: GraphqlError[] | undefined, statusCode: number): boolean {
  if (statusCode === 429) {
    return true;
  }

  return (errors ?? []).some((error) => error.extensions?.code === "THROTTLED");
}

function isThrownThrottleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /throttled|too many requests|429/i.test(error.message);
}

function getRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;

  if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1_000;
  }

  return BASE_RETRY_DELAY_MS * 2 ** attempt;
}

export async function shopifyAdminGraphqlRequest<TData, TVariables extends Record<string, unknown> | undefined = undefined>(
  shopDomain: string,
  query: string,
  variables?: TVariables,
): Promise<TData> {
  const { admin } = await unauthenticated.admin(shopDomain);

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    let response: Response;

    try {
      response = await admin.graphql(query, {
        variables,
      });
    } catch (error) {
      if (attempt < DEFAULT_MAX_RETRIES && isThrownThrottleError(error)) {
        await sleep(getRetryDelayMs(attempt, null));
        continue;
      }

      throw error;
    }

    let payload: GraphqlEnvelope<TData>;

    try {
      payload = (await response.json()) as GraphqlEnvelope<TData>;
    } catch (error) {
      throw new ShopifyAdminGraphqlError("Shopify Admin API returned a non-JSON response.", shopDomain, error);
    }

    if (response.ok && !payload.errors?.length) {
      if (!payload.data) {
        throw new ShopifyAdminGraphqlError("Shopify Admin API response did not include data.", shopDomain, payload);
      }

      return payload.data;
    }

    if (attempt < DEFAULT_MAX_RETRIES && isThrottled(payload.errors, response.status)) {
      await sleep(getRetryDelayMs(attempt, response.headers.get("Retry-After")));
      continue;
    }

    throw new ShopifyAdminGraphqlError(
      `Shopify Admin API request failed for ${shopDomain}.`,
      shopDomain,
      {
        statusCode: response.status,
        errors: payload.errors,
      },
    );
  }

  throw new ShopifyAdminGraphqlError(`Shopify Admin API request exhausted retries for ${shopDomain}.`, shopDomain);
}
