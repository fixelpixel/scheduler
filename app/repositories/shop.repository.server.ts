import type { Prisma, Shop } from "@prisma/client";

import prisma from "../db.server";

export type UpsertShopConfigInput = {
  shopDomain: string;
  targetPublicationId?: string | null;
  metafieldNamespace?: string;
  startDateKey?: string;
  endDateKey?: string;
  shopIanaTimezone?: string | null;
  isActive?: boolean;
  lastSyncedAt?: Date | null;
};

class ShopRepository {
  findByShopDomain(shopDomain: string) {
    return prisma.shop.findUnique({
      where: { shopDomain },
    });
  }

  findAllActive() {
    return prisma.shop.findMany({
      where: { isActive: true },
      orderBy: { shopDomain: "asc" },
    });
  }

  async upsertConfig(input: UpsertShopConfigInput): Promise<Shop> {
    const createData: Prisma.ShopCreateInput = {
      shopDomain: input.shopDomain,
      targetPublicationId: input.targetPublicationId ?? null,
      metafieldNamespace: input.metafieldNamespace ?? "custom",
      startDateKey: input.startDateKey ?? "start_date",
      endDateKey: input.endDateKey ?? "end_date",
      shopIanaTimezone: input.shopIanaTimezone ?? null,
      isActive: input.isActive ?? true,
      lastSyncedAt: input.lastSyncedAt ?? null,
    };

    const updateData: Prisma.ShopUpdateInput = {};

    if (input.targetPublicationId !== undefined) {
      updateData.targetPublicationId = input.targetPublicationId;
    }

    if (input.metafieldNamespace !== undefined) {
      updateData.metafieldNamespace = input.metafieldNamespace;
    }

    if (input.startDateKey !== undefined) {
      updateData.startDateKey = input.startDateKey;
    }

    if (input.endDateKey !== undefined) {
      updateData.endDateKey = input.endDateKey;
    }

    if (input.shopIanaTimezone !== undefined) {
      updateData.shopIanaTimezone = input.shopIanaTimezone;
    }

    if (input.isActive !== undefined) {
      updateData.isActive = input.isActive;
    }

    if (input.lastSyncedAt !== undefined) {
      updateData.lastSyncedAt = input.lastSyncedAt;
    }

    return prisma.shop.upsert({
      where: { shopDomain: input.shopDomain },
      create: createData,
      update: updateData,
    });
  }

  updateAfterSync(shopId: string, syncedAt: Date) {
    return prisma.shop.update({
      where: { id: shopId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  deactivateByShopDomain(shopDomain: string) {
    return prisma.shop.updateMany({
      where: { shopDomain },
      data: {
        isActive: false,
        targetPublicationId: null,
      },
    });
  }
}

export const shopRepository = new ShopRepository();

