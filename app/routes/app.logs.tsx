import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Badge, Banner, DataTable } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { shopRepository } from "../repositories/shop.repository.server";
import { syncLogRepository } from "../repositories/sync-log.repository.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await shopRepository.findByShopDomain(session.shop);

  if (!shop) {
    return json({ logs: [] });
  }

  const logs = await syncLogRepository.findRecentByShop(shop.id, 100);

  return json({ logs });
};

type LogStatus = "SUCCESS" | "ERROR" | "SKIPPED" | "DRY_RUN";
type LogDesiredState = "PUBLISHED" | "UNPUBLISHED" | "UNKNOWN";

function statusTone(status: LogStatus) {
  if (status === "SUCCESS") return "success" as const;
  if (status === "ERROR") return "critical" as const;
  return "info" as const;
}

function desiredStateTone(state: LogDesiredState) {
  if (state === "PUBLISHED") return "success" as const;
  if (state === "UNPUBLISHED") return "warning" as const;
  return "info" as const;
}

export default function LogsPage() {
  const { logs } = useLoaderData<typeof loader>();

  const rows = logs.map((log: any) => [
    new Date(log.executedAt).toLocaleString(),
    <Text as="span" tone="subdued" key={log.id + "-col"}>
      {log.collectionGid.split("/").pop()}
    </Text>,
    <Badge tone={desiredStateTone(log.desiredState)} key={log.id + "-desired"}>
      {log.desiredState}
    </Badge>,
    <Text as="span" fontWeight="bold" key={log.id + "-action"}>
      {log.action}
    </Text>,
    <Badge tone={statusTone(log.status)} key={log.id + "-status"}>
      {log.status}
    </Badge>,
    log.message || "-",
  ]);

  return (
    <Page title="Sync Logs">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Recent Activity
              </Text>
              {logs.length === 0 ? (
                <Banner tone="info">
                  <Text as="p">
                    No sync logs found yet. Start a manual sync to see results here.
                  </Text>
                </Banner>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={["Time", "Collection", "Desired", "Action", "Status", "Message"]}
                  rows={rows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
