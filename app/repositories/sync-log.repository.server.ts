import { SyncAction, SyncDesiredState, SyncStatus } from "@prisma/client";

import prisma from "../db.server";

export type CreateSyncLogInput = {
  shopId: string;
  collectionGid: string;
  publicationGid: string;
  desiredState: SyncDesiredState;
  previousState?: boolean | null;
  action: SyncAction;
  status: SyncStatus;
  message?: string | null;
  executedAt?: Date;
  jobRunId?: string | null;
  dryRun?: boolean;
};

class SyncLogRepository {
  create(input: CreateSyncLogInput) {
    return prisma.syncLog.create({
      data: {
        shopId: input.shopId,
        collectionGid: input.collectionGid,
        publicationGid: input.publicationGid,
        desiredState: input.desiredState,
        previousState: input.previousState ?? null,
        action: input.action,
        status: input.status,
        message: input.message ?? null,
        executedAt: input.executedAt ?? new Date(),
        jobRunId: input.jobRunId ?? null,
        dryRun: input.dryRun ?? false,
      },
    });
  }

  findRecentByShop(shopId: string, limit: number = 50) {
    return prisma.syncLog.findMany({
      where: { shopId },
      orderBy: { executedAt: "desc" },
      take: limit,
    });
  }
}

export const syncLogRepository = new SyncLogRepository();

