import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";
import { runScheduleJobForShop } from "../jobs/run-schedule-job.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await shopRepository.findByShopDomain(session.shop);

  if (!shop) {
    return json({ shop: null, health: null, stats: null });
  }

  const health = {
    shopActive: shop.isActive,
    timezoneKnown: !!shop.shopIanaTimezone,
    publicationConfigured: !!shop.targetPublicationId,
    readyToRun: shop.isActive && !!shop.shopIanaTimezone && !!shop.targetPublicationId,
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
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "runSync") {
    const summary = await runScheduleJobForShop(session.shop, {
      dryRun: false,
      jobRunId: crypto.randomUUID(),
    });
    return json({ summary });
  }

  return json({ error: "Unknown action" });
};

export default function DashboardPage() {
  const { shop, health, stats } = useLoaderData<typeof loader>();
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

  return (
    <Page title="Collection Scheduler">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Platform Health
              </Text>
              <InlineGrid columns={3} gap="400">
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      App Status
                    </Text>
                    <Badge tone={health.shopActive ? "success" : "critical"}>
                      {health.shopActive ? "Active" : "Disabled"}
                    </Badge>
                  </BlockStack>
                </Box>
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      Target Publication
                    </Text>
                    <Badge tone={health.publicationConfigured ? "success" : "critical"}>
                      {health.publicationConfigured ? "Configured" : "Missing"}
                    </Badge>
                  </BlockStack>
                </Box>
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      Timezone
                    </Text>
                    <Badge tone={health.timezoneKnown ? "success" : "critical"}>
                      {health.timezoneKnown ? "Identified" : "Unknown"}
                    </Badge>
                  </BlockStack>
                </Box>
              </InlineGrid>
              {!health.publicationConfigured && (
                <Banner tone="critical" title="Publication Missing">
                  <Text as="p">
                    A target publication is not configured. The scheduler will not perform any
                    actions until you select a publication in the settings.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={2} gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Scheduler Status
                </Text>
                <BlockStack gap="200">
                  <Text as="p">
                    Shop:{" "}
                    <Text as="span" fontWeight="bold">
                      {shop.shopDomain}
                    </Text>
                  </Text>
                  <Text as="p">
                    Timezone:{" "}
                    <Text as="span" fontWeight="bold">
                      {shop.shopIanaTimezone || "Not set"}
                    </Text>
                  </Text>
                  <Text as="p">
                    Last run:{" "}
                    <Text as="span" fontWeight="bold">
                      {shop.lastSyncedAt
                        ? new Date(shop.lastSyncedAt).toLocaleString()
                        : "Never"}
                    </Text>
                  </Text>
                  <Text as="p">
                    Activity (24h):{" "}
                    <Text as="span" fontWeight="bold">
                      {stats?.recentLogsCount ?? 0} logs
                    </Text>
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Manual Control
                </Text>
                <Text as="p">
                  Manually trigger the sync service for this shop. This will scan all collections
                  and update their visibility based on the scheduled dates.
                </Text>
                <form method="post">
                  <input type="hidden" name="actionType" value="runSync" />
                  <Button
                    variant="primary"
                    loading={isRunning}
                    disabled={!health.readyToRun}
                    submit
                  >
                    Run sync now
                  </Button>
                </form>
                {(actionData as any)?.summary && (
                  <Banner tone="success" title="Sync Complete">
                    <BlockStack gap="100">
                      <Text as="p">
                        Scanned: {(actionData as any).summary.scannedCollections}
                      </Text>
                      <Text as="p">
                        Published: {(actionData as any).summary.publishedCount}
                      </Text>
                      <Text as="p">
                        Unpublished: {(actionData as any).summary.unpublishedCount}
                      </Text>
                      <Text as="p">Errors: {(actionData as any).summary.errorCount}</Text>
                    </BlockStack>
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
