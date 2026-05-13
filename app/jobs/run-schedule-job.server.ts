import { SyncAction, SyncDesiredState, SyncStatus } from "@prisma/client";

import { shopRepository } from "../repositories/shop.repository.server";
import { syncLogRepository } from "../repositories/sync-log.repository.server";
import {
  getScheduledCollections,
  getShopIanaTimezone,
  syncCollectionVisibility,
} from "../services/collection-scheduler.server";
import { evaluateCollectionSchedule } from "../services/scheduler-engine.server";

export type RunScheduleJobOptions = {
  dryRun?: boolean;
  pageSize?: number;
  now?: Date;
  jobRunId?: string;
};

export type ShopScheduleRunSummary = {
  shopDomain: string;
  shopId: string | null;
  dryRun: boolean;
  scannedCollections: number;
  publishedCount: number;
  unpublishedCount: number;
  skippedCount: number;
  errorCount: number;
  messages: string[];
};

export type AllShopsScheduleRunSummary = {
  dryRun: boolean;
  totalShops: number;
  completedShops: number;
  failedShops: number;
  shops: ShopScheduleRunSummary[];
};

function evaluationReasonToAction(reason: string): SyncAction {
  switch (reason) {
    case "invalid_start_date":
    case "invalid_end_date":
    case "end_before_start":
      return SyncAction.ERROR;
    default:
      return SyncAction.SKIP;
  }
}

function evaluationReasonToStatus(reason: string): SyncStatus {
  switch (reason) {
    case "invalid_start_date":
    case "invalid_end_date":
    case "end_before_start":
      return SyncStatus.ERROR;
    default:
      return SyncStatus.SKIPPED;
  }
}

type AvailabilityMode = "managed" | "always_live" | "none";

function getAvailabilityMode(input: {
  availabilityModeValue: string | null | undefined;
  startDateValue: string | null | undefined;
  endDateValue: string | null | undefined;
}): AvailabilityMode {
  const explicitMode = input.availabilityModeValue?.trim().toLowerCase();
  if (explicitMode === "managed" || explicitMode === "always_live" || explicitMode === "none") {
    return explicitMode;
  }

  return input.startDateValue || input.endDateValue ? "managed" : "none";
}

export async function runScheduleJobForShop(
  shopDomain: string,
  options: RunScheduleJobOptions = {},
): Promise<ShopScheduleRunSummary> {
  const shop = await shopRepository.findByShopDomain(shopDomain);

  if (!shop) {
    throw new Error(`Shop ${shopDomain} is not configured.`);
  }

  if (!shop.isActive) {
    return {
      shopDomain,
      shopId: shop.id,
      dryRun: options.dryRun ?? false,
      scannedCollections: 0,
      publishedCount: 0,
      unpublishedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      messages: ["Shop is inactive. Scheduler run skipped."],
    };
  }

  if (!shop.targetPublicationId) {
    return {
      shopDomain,
      shopId: shop.id,
      dryRun: options.dryRun ?? false,
      scannedCollections: 0,
      publishedCount: 0,
      unpublishedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      messages: ["targetPublicationId is not configured."],
    };
  }

  let shopTimezone = shop.shopIanaTimezone;

  if (!shopTimezone) {
    shopTimezone = await getShopIanaTimezone(shop.shopDomain).then(async (timezone: string) => {
      await shopRepository.upsertConfig({
        shopDomain: shop.shopDomain,
        shopIanaTimezone: timezone,
      });

      return timezone;
    });
  }

  const summary: ShopScheduleRunSummary = {
    shopDomain,
    shopId: shop.id,
    dryRun: options.dryRun ?? false,
    scannedCollections: 0,
    publishedCount: 0,
    unpublishedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    messages: [],
  };

  let cursor: string | null = null;

  do {
    const page = await getScheduledCollections(shopDomain, {
      publicationId: shop.targetPublicationId,
      metafieldNamespace: shop.metafieldNamespace,
      startDateKey: shop.startDateKey,
      endDateKey: shop.endDateKey,
      cursor,
      pageSize: options.pageSize,
    });

    for (const collection of page.collections) {
      summary.scannedCollections += 1;

      const availabilityMode = getAvailabilityMode(collection);

      if (availabilityMode !== "managed") {
        const message =
          availabilityMode === "always_live"
            ? "Always live / reporting only. Scheduler did not change product status."
            : "No automation. Scheduler skipped this collection.";

        summary.skippedCount += 1;
        await syncLogRepository.create({
          shopId: shop.id,
          collectionGid: collection.id,
          publicationGid: shop.targetPublicationId,
          desiredState: SyncDesiredState.UNKNOWN,
          previousState: collection.isPublishedOnTargetPublication,
          action: SyncAction.SKIP,
          status: SyncStatus.SKIPPED,
          message,
          jobRunId: options.jobRunId ?? null,
          dryRun: options.dryRun ?? false,
        });

        continue;
      }

      const evaluation = evaluateCollectionSchedule({
        startDateValue: collection.startDateValue,
        endDateValue: collection.endDateValue,
        shopTimezone: shopTimezone ?? "UTC",
        now: options.now,
      });

      if (evaluation.outcome === "skip") {
        const action = evaluationReasonToAction(evaluation.reason);
        const status = evaluationReasonToStatus(evaluation.reason);

        let message = evaluation.message;
        if (evaluation.reason === "missing_start_date") {
          message = `Missing metafield: ${shop.metafieldNamespace}.${shop.startDateKey}`;
        } else if (evaluation.reason === "missing_end_date") {
          message = `Missing metafield: ${shop.metafieldNamespace}.${shop.endDateKey}`;
        }

        if (status === SyncStatus.ERROR) {
          summary.errorCount += 1;
        } else {
          summary.skippedCount += 1;
        }

        summary.messages.push(`${collection.id}: ${message}`);

        await syncLogRepository.create({
          shopId: shop.id,
          collectionGid: collection.id,
          publicationGid: shop.targetPublicationId,
          desiredState: SyncDesiredState.UNKNOWN,
          previousState: collection.isPublishedOnTargetPublication,
          action,
          status,
          message,
          jobRunId: options.jobRunId ?? null,
          dryRun: options.dryRun ?? false,
        });

        continue;
      }

      try {
        const syncResult = await syncCollectionVisibility(
          shopDomain,
          collection.id,
          shop.targetPublicationId,
          evaluation.shouldBePublished,
          { dryRun: options.dryRun },
        );

        let action: SyncAction = SyncAction.SKIP;
        let status: SyncStatus = SyncStatus.SKIPPED;
        let message = "No visibility change was required.";

        if (syncResult.action === "PUBLISH") {
          action = SyncAction.PUBLISH;
          status = syncResult.dryRun ? SyncStatus.SKIPPED : SyncStatus.SUCCESS;
          summary.publishedCount += 1;
          message = syncResult.dryRun
            ? "Dry run: products would be activated."
            : "Products in collection set to ACTIVE.";
        } else if (syncResult.action === "UNPUBLISH") {
          action = SyncAction.UNPUBLISH;
          status = syncResult.dryRun ? SyncStatus.SKIPPED : SyncStatus.SUCCESS;
          summary.unpublishedCount += 1;
          message = syncResult.dryRun
            ? "Dry run: products would be deactivated."
            : "Products in collection set to DRAFT.";
        } else {
          summary.skippedCount += 1;
        }

        await syncLogRepository.create({
          shopId: shop.id,
          collectionGid: collection.id,
          publicationGid: shop.targetPublicationId,
          desiredState:
            evaluation.desiredStateLabel === "PUBLISHED"
              ? SyncDesiredState.PUBLISHED
              : SyncDesiredState.UNPUBLISHED,
          previousState: syncResult.previousState,
          action,
          status,
          message,
          jobRunId: options.jobRunId ?? null,
          dryRun: options.dryRun ?? false,
        });
      } catch (error) {
        summary.errorCount += 1;
        const message = error instanceof Error ? error.message : "Unknown scheduler error.";
        console.error("[ScheduleJob] Collection sync failed.", {
          shopDomain,
          message,
        });
        summary.messages.push(`${collection.id}: ${message}`);

        await syncLogRepository.create({
          shopId: shop.id,
          collectionGid: collection.id,
          publicationGid: shop.targetPublicationId,
          desiredState:
            evaluation.desiredStateLabel === "PUBLISHED"
              ? SyncDesiredState.PUBLISHED
              : SyncDesiredState.UNPUBLISHED,
          previousState: collection.isPublishedOnTargetPublication,
          action: SyncAction.ERROR,
          status: SyncStatus.ERROR,
          message,
          jobRunId: options.jobRunId ?? null,
          dryRun: options.dryRun ?? false,
        });
      }
    }

    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  if (!options.dryRun) {
    await shopRepository.updateAfterSync(shop.id, new Date());
  }

  return summary;
}

export async function runScheduleJobForAllActiveShops(
  options: RunScheduleJobOptions = {},
): Promise<AllShopsScheduleRunSummary> {
  const shops = await shopRepository.findAllActive();
  const summaries: ShopScheduleRunSummary[] = [];
  let failedShops = 0;

  for (const shop of shops) {
    try {
      summaries.push(await runScheduleJobForShop(shop.shopDomain, options));
    } catch (error) {
      failedShops += 1;
      summaries.push({
        shopDomain: shop.shopDomain,
        shopId: shop.id,
        dryRun: options.dryRun ?? false,
        scannedCollections: 0,
        publishedCount: 0,
        unpublishedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        messages: [error instanceof Error ? error.message : "Unknown shop-level scheduler error."],
      });
    }
  }

  return {
    dryRun: options.dryRun ?? false,
    totalShops: shops.length,
    completedShops: shops.length - failedShops,
    failedShops,
    shops: summaries,
  };
}
