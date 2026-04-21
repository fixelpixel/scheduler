import { useState } from "react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Select,
  TextField,
  Button,
  Banner,
  Text,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopRepository.findByShopDomain(session.shop);

  const response = await admin.graphql(
    `#graphql
    query GetPublications($first: Int!) {
      publications(first: $first) {
        nodes { id name }
      }
    }`,
    { variables: { first: 250 } },
  );

  const payload = await response.json();
  const publications: Array<{ id: string; name: string }> =
    payload.data?.publications?.nodes || [];

  return json({ shop, publications });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const targetPublicationId = formData.get("targetPublicationId") as string;
  const metafieldNamespace = (formData.get("metafieldNamespace") as string) || "custom";
  const startDateKey = (formData.get("startDateKey") as string) || "start_date";
  const endDateKey = (formData.get("endDateKey") as string) || "end_date";

  await shopRepository.upsertConfig({
    shopDomain: session.shop,
    targetPublicationId,
    metafieldNamespace,
    startDateKey,
    endDateKey,
  });

  return json({ success: true });
};

export default function SettingsPage() {
  const { shop, publications } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  const [publicationId, setPublicationId] = useState(shop?.targetPublicationId || "");
  const [namespace, setNamespace] = useState(shop?.metafieldNamespace || "custom");
  const [startKey, setStartKey] = useState(shop?.startDateKey || "start_date");
  const [endKey, setEndKey] = useState(shop?.endDateKey || "end_date");

  const pubOptions = [
    { label: "Select a publication", value: "", disabled: true },
    ...publications.map((pub) => ({ label: pub.name, value: pub.id })),
  ];

  return (
    <Page title="Settings">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Publication
              </Text>
              <Text as="p" tone="subdued">
                The publication where collections will be published or unpublished by the
                scheduler.
              </Text>
              <form method="post">
                <BlockStack gap="400">
                  <Select
                    label="Target Publication"
                    name="targetPublicationId"
                    options={pubOptions}
                    value={publicationId}
                    onChange={setPublicationId}
                  />
                  <input type="hidden" name="metafieldNamespace" value={namespace} />
                  <input type="hidden" name="startDateKey" value={startKey} />
                  <input type="hidden" name="endDateKey" value={endKey} />
                  <Button variant="primary" loading={isLoading} submit>
                    Save
                  </Button>
                </BlockStack>
              </form>
              {actionData?.success && (
                <Banner title="Saved" tone="success">
                  <Text as="p">Settings updated.</Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Metafield Keys
              </Text>
              <Text as="p" tone="subdued">
                Namespace and keys used to read schedule dates from collection metafields.
                Default is <strong>custom</strong> / <strong>start_date</strong> /{" "}
                <strong>end_date</strong> — matches the standard Shopify metafield setup.
              </Text>
              <form method="post">
                <BlockStack gap="400">
                  <input type="hidden" name="targetPublicationId" value={publicationId} />
                  <InlineGrid columns={3} gap="400">
                    <TextField
                      label="Namespace"
                      name="metafieldNamespace"
                      value={namespace}
                      onChange={setNamespace}
                      autoComplete="off"
                    />
                    <TextField
                      label="Start Date Key"
                      name="startDateKey"
                      value={startKey}
                      onChange={setStartKey}
                      autoComplete="off"
                    />
                    <TextField
                      label="End Date Key"
                      name="endDateKey"
                      value={endKey}
                      onChange={setEndKey}
                      autoComplete="off"
                    />
                  </InlineGrid>
                  <Button loading={isLoading} submit>
                    Save Keys
                  </Button>
                </BlockStack>
              </form>

              <Divider />

              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  Current config on server:
                </Text>
                <Text as="p" variant="bodyMd">
                  <code>{shop?.metafieldNamespace}.{shop?.startDateKey}</code> /{" "}
                  <code>{shop?.metafieldNamespace}.{shop?.endDateKey}</code>
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Banner tone="warning" title="Required: write_products scope">
            <Text as="p">
              To edit collection schedules from this app, the{" "}
              <strong>write_products</strong> permission must be granted. If the Collections
              editor shows a permission error, re-install the app from the Shopify Partners
              dashboard to grant the updated scope.
            </Text>
          </Banner>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
