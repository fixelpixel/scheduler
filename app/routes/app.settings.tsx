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
  Badge,
  InlineStack,
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
  NOTICE_SETTINGS_KEY,
  NOTICE_VARIANT_KEY,
  SCHEDULE_NAMESPACE_FALLBACK,
  START_DATE_KEY_FALLBACK,
  STOREFRONT_MODE_KEY,
} from "../services/schedule-contract";

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

  const isScopeGranted = session.scope?.split(",").includes("write_products");
  return json({ shop, publications, isScopeGranted });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "setActive") {
    const isActive = formData.get("isActive") === "true";

    await shopRepository.upsertConfig({
      shopDomain: session.shop,
      isActive,
    });

    return json({ success: true, statusChanged: true, isActive });
  }

  if (actionType === "createDefinitions") {
    const shop = await shopRepository.findByShopDomain(session.shop);
    const namespace = shop?.metafieldNamespace || SCHEDULE_NAMESPACE_FALLBACK;
    const startKey = shop?.startDateKey || START_DATE_KEY_FALLBACK;
    const endKey = shop?.endDateKey || END_DATE_KEY_FALLBACK;

    const createDef = async (key: string, name: string, type = "date_time") => {
      return admin.graphql(
        `#graphql
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            definition: {
              namespace,
              key,
              name,
              ownerType: "COLLECTION",
              type,
            },
          },
        },
      );
    };

    const resStart = await createDef(startKey, "Schedule Start Date");
    const resEnd = await createDef(endKey, "Schedule End Date");
    const resAvailabilityMode = await createDef(AVAILABILITY_MODE_KEY, "Schedule Availability Mode", "single_line_text_field");
    const resStorefrontMode = await createDef(STOREFRONT_MODE_KEY, "Schedule Storefront Mode", "single_line_text_field");
    const resDisplayMode = await createDef(DISPLAY_MODE_KEY, "Legacy Schedule Display Mode", "single_line_text_field");
    const resCustomMessage = await createDef(CUSTOM_MESSAGE_KEY, "Schedule Custom Message", "multi_line_text_field");
    const resCheckoutMode = await createDef(CHECKOUT_MODE_KEY, "Schedule Checkout Mode", "single_line_text_field");
    const resCheckoutMessage = await createDef(CHECKOUT_MESSAGE_KEY, "Schedule Checkout Message", "multi_line_text_field");
    const resNoticeVariant = await createDef(NOTICE_VARIANT_KEY, "Schedule Notice Variant", "single_line_text_field");
    const resNoticeSettings = await createDef(NOTICE_SETTINGS_KEY, "Schedule Notice Settings", "json");

    return json({
      success: true,
      created: true,
      details: {
        start: await resStart.json(),
        end: await resEnd.json(),
        availabilityMode: await resAvailabilityMode.json(),
        storefrontMode: await resStorefrontMode.json(),
        displayMode: await resDisplayMode.json(),
        customMessage: await resCustomMessage.json(),
        checkoutMode: await resCheckoutMode.json(),
        checkoutMessage: await resCheckoutMessage.json(),
        noticeVariant: await resNoticeVariant.json(),
        noticeSettings: await resNoticeSettings.json(),
      }
    });
  }

  const targetPublicationId = formData.get("targetPublicationId") as string;
  const metafieldNamespace =
    (formData.get("metafieldNamespace") as string) || SCHEDULE_NAMESPACE_FALLBACK;
  const startDateKey =
    (formData.get("startDateKey") as string) || START_DATE_KEY_FALLBACK;
  const endDateKey =
    (formData.get("endDateKey") as string) || END_DATE_KEY_FALLBACK;

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
  const { shop, publications, isScopeGranted } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  const [publicationId, setPublicationId] = useState(shop?.targetPublicationId || "");
  const [namespace, setNamespace] = useState(
    shop?.metafieldNamespace || SCHEDULE_NAMESPACE_FALLBACK,
  );
  const [startKey, setStartKey] = useState(shop?.startDateKey || START_DATE_KEY_FALLBACK);
  const [endKey, setEndKey] = useState(shop?.endDateKey || END_DATE_KEY_FALLBACK);
  const isSchedulerActive = shop?.isActive ?? false;

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
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Scheduler Status
                  </Text>
                  <Text as="p" tone="subdued">
                    When disabled, automatic and manual sync runs will not change products.
                  </Text>
                </BlockStack>
                <Badge tone={isSchedulerActive ? "success" : "critical"}>
                  {isSchedulerActive ? "On" : "Off"}
                </Badge>
              </InlineStack>
              <form method="post">
                <input type="hidden" name="actionType" value="setActive" />
                <input
                  type="hidden"
                  name="isActive"
                  value={isSchedulerActive ? "false" : "true"}
                />
                <Button loading={isLoading} submit>
                  {isSchedulerActive ? "Turn Scheduler Off" : "Turn Scheduler On"}
                </Button>
              </form>
              {(actionData as any)?.statusChanged && (
                <Banner title="Scheduler status saved" tone="success">
                  <Text as="p">
                    Scheduler is now {(actionData as any).isActive ? "on" : "off"}.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

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
                Default is <strong>{SCHEDULE_NAMESPACE_FALLBACK}</strong> /{" "}
                <strong>{START_DATE_KEY_FALLBACK}</strong> /{" "}
                <strong>{END_DATE_KEY_FALLBACK}</strong> — matches the Scheduler metafield setup.
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
          {isScopeGranted ? (
            <Banner tone="success" title="Permissions Verified">
              <Text as="p">
                The <strong>write_products</strong> scope is granted. You can now manage
                collection schedules and product statuses.
              </Text>
            </Banner>
          ) : (
            <Banner tone="warning" title="Required: write_products scope">
              <Text as="p">
                To edit collection schedules from this app, the{" "}
                <strong>write_products</strong> permission must be granted. If the Collections
                editor shows a permission error, re-install the app from the Shopify Partners
                dashboard to grant the updated scope.
              </Text>
            </Banner>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
