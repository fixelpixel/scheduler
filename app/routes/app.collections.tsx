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
  Modal,
  Banner,
  Pagination,
  EmptyState,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";

// ─── Types ───────────────────────────────────────────────────────────────────

type MetafieldNode = { id: string; value: string } | null;

type CollectionRow = {
  id: string;
  title: string;
  handle: string;
  isPublished: boolean;
  startDateMeta: MetafieldNode;
  endDateMeta: MetafieldNode;
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
  publicationId: string | null;
  configMissing: boolean;
};

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
      namespace: shop?.metafieldNamespace ?? "custom",
      startKey: shop?.startDateKey ?? "start_date",
      endKey: shop?.endDateKey ?? "end_date",
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
        }
      }
    }`,
    { variables },
  );

  const payload = await response.json();
  const raw = payload.data?.collections;

  const collections: CollectionRow[] = (raw?.nodes ?? []).map((node: any) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    isPublished: node.publishedOnPublication,
    startDateMeta: node.startDateMeta ?? null,
    endDateMeta: node.endDateMeta ?? null,
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

  const namespace = shop?.metafieldNamespace ?? "custom";
  const startKey = shop?.startDateKey ?? "start_date";
  const endKey = shop?.endDateKey ?? "end_date";

  if (actionType === "setSchedule") {
    const collectionId = formData.get("collectionId") as string;
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;

    try {
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
            metafields: [
              {
                ownerId: collectionId,
                namespace,
                key: startKey,
                value: `${startDate}T00:00:00Z`,
                type: "date_time",
              },
              {
                ownerId: collectionId,
                namespace,
                key: endKey,
                value: `${endDate}T00:00:00Z`,
                type: "date_time",
              },
            ],
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

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.includes("T") ? iso.split("T")[0] : iso;
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

function scheduleStatus(
  startMeta: MetafieldNode,
  endMeta: MetafieldNode,
): "active" | "expired" | "pending" | "none" {
  if (!startMeta || !endMeta) return "none";
  const today = new Date().toISOString().split("T")[0];
  const start = isoToDateInput(startMeta.value);
  const end = isoToDateInput(endMeta.value);
  if (today >= start && today <= end) return "active";
  if (today > end) return "expired";
  return "pending";
}

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "critical", label: "Expired" },
  pending: { tone: "attention", label: "Pending" },
  none: { tone: "info", label: "No schedule" },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function CollectionsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [editingCollection, setEditingCollection] = useState<CollectionRow | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [searchValue, setSearchValue] = useState(searchParams.get("q") ?? "");

  const openEdit = useCallback((col: CollectionRow) => {
    setEditingCollection(col);
    setStartDate(isoToDateInput(col.startDateMeta?.value));
    setEndDate(isoToDateInput(col.endDateMeta?.value));
  }, []);

  const closeEdit = useCallback(() => {
    setEditingCollection(null);
    setStartDate("");
    setEndDate("");
  }, []);

  const handleSave = useCallback(() => {
    if (!editingCollection) return;
    fetcher.submit(
      {
        actionType: "setSchedule",
        collectionId: editingCollection.id,
        startDate,
        endDate,
      },
      { method: "post" },
    );
    closeEdit();
  }, [editingCollection, startDate, endDate, fetcher, closeEdit]);

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
                  <Text as="p">Try a different search term or clear the filter.</Text>
                </EmptyState>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Collection", "Schedule Status", "Start Date", "End Date", "Published", ""].map(
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
                        const status = scheduleStatus(col.startDateMeta, col.endDateMeta);
                        const badge = STATUS_BADGE[status];
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
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <Text as="span" variant="bodySm">
                                {isoToDateInput(col.startDateMeta?.value) || "—"}
                              </Text>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <Text as="span" variant="bodySm">
                                {isoToDateInput(col.endDateMeta?.value) || "—"}
                              </Text>
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
                                    Clear
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
          disabled: !startDate || !endDate,
          loading: isSaving,
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeEdit }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Dates are in <strong>YYYY-MM-DD</strong> format. The scheduler runs in the
              shop's timezone ({data.namespace}).
            </Text>
            <InlineGrid columns={2} gap="400">
              <TextField
                label="Start Date"
                type="date"
                value={startDate}
                onChange={setStartDate}
                autoComplete="off"
              />
              <TextField
                label="End Date"
                type="date"
                value={endDate}
                onChange={setEndDate}
                autoComplete="off"
              />
            </InlineGrid>
            {startDate && endDate && endDate < startDate && (
              <Banner tone="critical">
                <Text as="p">End date must be after start date.</Text>
              </Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
