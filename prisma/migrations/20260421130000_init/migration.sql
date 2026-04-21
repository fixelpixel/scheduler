-- CreateEnum
CREATE TYPE "SyncDesiredState" AS ENUM ('PUBLISHED', 'UNPUBLISHED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SyncAction" AS ENUM ('PUBLISH', 'UNPUBLISH', 'SKIP', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('SUCCESS', 'SKIPPED', 'ERROR', 'DRY_RUN');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "targetPublicationId" TEXT,
    "metafieldNamespace" TEXT NOT NULL DEFAULT 'schedule',
    "startDateKey" TEXT NOT NULL DEFAULT 'start_date',
    "endDateKey" TEXT NOT NULL DEFAULT 'end_date',
    "shopIanaTimezone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "collectionGid" TEXT NOT NULL,
    "publicationGid" TEXT NOT NULL,
    "desiredState" "SyncDesiredState" NOT NULL DEFAULT 'UNKNOWN',
    "previousState" BOOLEAN,
    "action" "SyncAction" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "message" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobRunId" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_isOnline_idx" ON "Session"("shop", "isOnline");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_isActive_idx" ON "Shop"("isActive");

-- CreateIndex
CREATE INDEX "SyncLog_shopId_executedAt_idx" ON "SyncLog"("shopId", "executedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncLog_collectionGid_publicationGid_executedAt_idx" ON "SyncLog"("collectionGid", "publicationGid", "executedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncLog_jobRunId_idx" ON "SyncLog"("jobRunId");

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
