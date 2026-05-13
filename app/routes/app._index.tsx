import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  Badge,
  Banner,
  Button,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";
import { runScheduleJobForShop } from "../jobs/run-schedule-job.server";
import prisma from "../db.server";
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

  if (!shop) {
    return json({ shop: null, health: null, stats: null, definitionsMissing: null });
  }

  const response = await admin.graphql(
    `#graphql
    query GetMetafieldDefinitions {
      metafieldDefinitions(first: 250, ownerType: COLLECTION) {
        nodes {
          namespace
          key
        }
      }
    }`,
  );

  const payload = (await response.json()) as any;
  const definitions = payload.data?.metafieldDefinitions?.nodes || [];
  const namespace = shop.metafieldNamespace || SCHEDULE_NAMESPACE_FALLBACK;
  const startKey = shop.startDateKey || START_DATE_KEY_FALLBACK;
  const endKey = shop.endDateKey || END_DATE_KEY_FALLBACK;
  const hasDefinition = (key: string) =>
    definitions.some((d: any) => d.namespace === namespace && d.key === key);

  const startKeyExists = hasDefinition(startKey);
  const endKeyExists = hasDefinition(endKey);
  const availabilityModeExists = hasDefinition(AVAILABILITY_MODE_KEY);
  const storefrontModeExists = hasDefinition(STOREFRONT_MODE_KEY);
  const displayModeExists = hasDefinition(DISPLAY_MODE_KEY);
  const customMessageExists = hasDefinition(CUSTOM_MESSAGE_KEY);
  const checkoutModeExists = hasDefinition(CHECKOUT_MODE_KEY);
  const checkoutMessageExists = hasDefinition(CHECKOUT_MESSAGE_KEY);
  const noticeVariantExists = hasDefinition(NOTICE_VARIANT_KEY);
  const noticeSettingsExists = hasDefinition(NOTICE_SETTINGS_KEY);

  const adminMetafieldsDefined =
    startKeyExists &&
    endKeyExists &&
    availabilityModeExists &&
    storefrontModeExists &&
    displayModeExists &&
    customMessageExists &&
    checkoutModeExists &&
    checkoutMessageExists &&
    noticeVariantExists &&
    noticeSettingsExists;

  const health = {
    shopActive: shop.isActive,
    timezoneKnown: !!shop.shopIanaTimezone,
    publicationConfigured: !!shop.targetPublicationId,
    metafieldsDefined: adminMetafieldsDefined,
    storefrontMetafieldsDefined: availabilityModeExists && storefrontModeExists && displayModeExists && customMessageExists,
    checkoutMetafieldsDefined: checkoutModeExists && checkoutMessageExists && noticeVariantExists && noticeSettingsExists,
    readyToRun: shop.isActive && !!shop.shopIanaTimezone && !!shop.targetPublicationId && startKeyExists && endKeyExists,
  };

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentLogsCount = await prisma.syncLog.count({
    where: {
      shopId: shop.id,
      executedAt: { gte: dayAgo },
    },
  });

  return json({
    shop,
    health,
    stats: { recentLogsCount },
    definitionsMissing: {
      start: !startKeyExists,
      end: !endKeyExists,
      availabilityMode: !availabilityModeExists,
      storefrontMode: !storefrontModeExists,
      displayMode: !displayModeExists,
      customMessage: !customMessageExists,
      checkoutMode: !checkoutModeExists,
      checkoutMessage: !checkoutMessageExists,
      noticeVariant: !noticeVariantExists,
      noticeSettings: !noticeSettingsExists,
    }
  });
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

  if (actionType === "runSync") {
    const summary = await runScheduleJobForShop(session.shop, {
      dryRun: false,
      jobRunId: crypto.randomUUID(),
    });
    return json({ summary });
  }

  if (actionType === "createMissingDefinitions") {
    const shop = await shopRepository.findByShopDomain(session.shop);
    if (!shop) return json({ error: "Shop not found" });

    const namespace = shop.metafieldNamespace || SCHEDULE_NAMESPACE_FALLBACK;
    const startKey = shop.startDateKey || START_DATE_KEY_FALLBACK;
    const endKey = shop.endDateKey || END_DATE_KEY_FALLBACK;

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

    await createDef(startKey, "Schedule Start Date");
    await createDef(endKey, "Schedule End Date");
    await createDef(AVAILABILITY_MODE_KEY, "Schedule Availability Mode", "single_line_text_field");
    await createDef(STOREFRONT_MODE_KEY, "Schedule Storefront Mode", "single_line_text_field");
    await createDef(DISPLAY_MODE_KEY, "Legacy Schedule Display Mode", "single_line_text_field");
    await createDef(CUSTOM_MESSAGE_KEY, "Schedule Custom Message", "multi_line_text_field");
    await createDef(CHECKOUT_MODE_KEY, "Schedule Checkout Mode", "single_line_text_field");
    await createDef(CHECKOUT_MESSAGE_KEY, "Schedule Checkout Message", "multi_line_text_field");
    await createDef(NOTICE_VARIANT_KEY, "Schedule Notice Variant", "single_line_text_field");
    await createDef(NOTICE_SETTINGS_KEY, "Schedule Notice Settings", "json");

    return json({ success: true, message: `Metafield definitions created in namespace '${namespace}'.` });
  }

  return json({ error: "Unknown action" });
};

export default function DashboardPage() {
  const { shop, health, stats, definitionsMissing } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isRunning = navigation.state === "submitting";

  if (!shop || !health) {
    return (
      <Page title="Dashboard">
        <Banner tone="critical" title="Configuration Error">
          <Text as="p">
            Shop configuration record not found in the database. Please contact support.
          </Text>
        </Banner>
      </Page>
    );
  }

  const missingMetafieldKeys = [
    definitionsMissing?.start ? shop.startDateKey : null,
    definitionsMissing?.end ? shop.endDateKey : null,
    definitionsMissing?.availabilityMode ? AVAILABILITY_MODE_KEY : null,
    definitionsMissing?.storefrontMode ? STOREFRONT_MODE_KEY : null,
    definitionsMissing?.displayMode ? DISPLAY_MODE_KEY : null,
    definitionsMissing?.customMessage ? CUSTOM_MESSAGE_KEY : null,
    definitionsMissing?.checkoutMode ? CHECKOUT_MODE_KEY : null,
    definitionsMissing?.checkoutMessage ? CHECKOUT_MESSAGE_KEY : null,
    definitionsMissing?.noticeVariant ? NOTICE_VARIANT_KEY : null,
    definitionsMissing?.noticeSettings ? NOTICE_SETTINGS_KEY : null,
  ].filter(Boolean);

  const setupSteps = [
    {
      title: "Enable Scheduler",
      status: health.shopActive ? "complete" : "incomplete",
      description: "Keep the scheduler off until the setup is reviewed and ready.",
    },
    {
      title: "Confirm Shop Timezone",
      status: health.timezoneKnown ? "complete" : "incomplete",
      description: "We use your shop's IANA timezone to schedule precise activations.",
    },
    {
      title: "Configure Target Publication",
      status: health.publicationConfigured ? "complete" : "incomplete",
      description: "Select which Sales Channel (e.g., Online Store) the scheduler should manage.",
    },
    {
      title: "Set Metafield Keys",
      status: health.metafieldsDefined ? "complete" : "incomplete",
      description: (
        <BlockStack gap="100">
          <Text as="span" variant="bodySm" tone="subdued">
            Define where schedule data is stored in your collections.
          </Text>
          {missingMetafieldKeys.length > 0 && (
            <BlockStack gap="200">
              <Text as="span" variant="bodySm" tone="critical">
                Missing in Shopify: {missingMetafieldKeys.map((key) => `'${key}'`).join(", ")}
              </Text>
              <Form method="POST">
                <input type="hidden" name="actionType" value="createMissingDefinitions" />
                <Button size="slim" submit loading={isRunning}>
                  Create Definitions in Shopify
                </Button>
              </Form>
            </BlockStack>
          )}
        </BlockStack>
      ),
    },
  ];

  return (
    <Page title="Collection Scheduler">
      <Layout>
        {!health.shopActive && (
          <Layout.Section>
            <Banner tone="warning" title="Scheduler is Off">
              <Text as="p">
                The app will not change product statuses until the scheduler is turned on.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {health.shopActive && !health.readyToRun && (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Action Required: Complete App Setup"
              action={{ content: "Go to Settings", url: "/app/settings" }}
            >
              <Text as="p">
                The scheduler is currently disabled because some configuration is incomplete or missing in Shopify.
                Please complete the setup guide below to enable automatic synchronization.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Setup Progress
              </Text>
              <BlockStack gap="200">
                {setupSteps.map((step, idx) => (
                  <Box
                    key={idx}
                    padding="300"
                    background={step.status === "complete" ? "bg-surface-success" : "bg-surface-secondary"}
                    borderRadius="200"
                  >
                    <InlineStack align="space-between">
                      <BlockStack gap="100">
                        <Text as="span" fontWeight="bold">
                          {step.title}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {step.description}
                        </Text>
                      </BlockStack>
                      <Badge tone={step.status === "complete" ? "success" : "attention"}>
                        {step.status === "complete" ? "Done" : "Pending"}
                      </Badge>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={2} gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Platform Health
                </Text>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="p">App Status</Text>
                    <Badge tone={health.shopActive ? "success" : "critical"}>
                      {health.shopActive ? "Active" : "Disabled"}
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p">Last Run</Text>
                    <Text as="p" fontWeight="bold">
                      {shop.lastSyncedAt ? new Date(shop.lastSyncedAt).toLocaleTimeString() : "Never"}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p">Activity (24h)</Text>
                    <Text as="p" fontWeight="bold">
                      {stats?.recentLogsCount ?? 0} logs
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Manual Control
                </Text>
                <BlockStack gap="300">
                  <Form method="POST">
                    <input type="hidden" name="actionType" value="setActive" />
                    <input
                      type="hidden"
                      name="isActive"
                      value={health.shopActive ? "false" : "true"}
                    />
                    <Button loading={isRunning} submit fullWidth>
                      {health.shopActive ? "Turn Scheduler Off" : "Turn Scheduler On"}
                    </Button>
                  </Form>
                  <Form method="POST">
                    <input type="hidden" name="actionType" value="runSync" />
                    <Button
                      variant="primary"
                      loading={isRunning}
                      disabled={!health.readyToRun}
                      submit
                      fullWidth
                    >
                      Run Sync Now
                    </Button>
                  </Form>
                  {!health.readyToRun && (
                    <Text as="p" variant="bodySm" tone="critical" alignment="center">
                      Settings must be completed before running sync.
                    </Text>
                  )}
                </BlockStack>

                {(actionData as any)?.summary && (
                  <Banner tone="success" title="Sync Complete">
                    <BlockStack gap="100">
                      <Text as="p">Scanned: {(actionData as any).summary.scannedCollections}</Text>
                      <Text as="p">Published (Active): {(actionData as any).summary.publishedCount}</Text>
                      <Text as="p">Unpublished (Draft): {(actionData as any).summary.unpublishedCount}</Text>
                      <Text as="p">Errors: {(actionData as any).summary.errorCount}</Text>
                    </BlockStack>
                  </Banner>
                )}
                {(actionData as any)?.statusChanged && (
                  <Banner tone="success" title="Scheduler status saved">
                    <Text as="p">
                      Scheduler is now {(actionData as any).isActive ? "on" : "off"}.
                    </Text>
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
