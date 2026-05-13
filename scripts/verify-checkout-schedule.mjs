import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const rootDir = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-checkout-verify-"));

async function transpileToTemp(relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  const source = await readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName: sourcePath,
  });

  const outputPath = path.join(tempDir, relativePath).replace(/\.ts$/, ".js").replace(/\.tsx$/, ".js");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const outputText = transpiled.outputText.replace(/from "(\.{1,2}\/[^"]+)";/g, 'from "$1.js";');
  await writeFile(outputPath, outputText, "utf8");
  return outputPath;
}

try {
  await transpileToTemp("app/services/schedule-contract.ts");
  await mkdir(path.join(tempDir, "app/repositories"), { recursive: true });
  await writeFile(
    path.join(tempDir, "app/repositories/shop.repository.server.js"),
    "export const shopRepository = { findByShopDomain: async () => ({ metafieldNamespace: 'schedule', startDateKey: 'start_date', endDateKey: 'end_date', shopIanaTimezone: 'UTC' }) };\n",
    "utf8",
  );
  await writeFile(
    path.join(tempDir, "app/services/shopify-admin.server.js"),
    `export async function shopifyAdminGraphqlRequest(_shop, _query, variables) {
      if (globalThis.__checkoutVerifyMode === "two-page") {
        const isFirstPage = variables.after == null;
        return {
          product: {
            collections: {
              pageInfo: { hasNextPage: isFirstPage, endCursor: isFirstPage ? "page-2" : null },
              nodes: isFirstPage ? [] : [
                {
                  handle: "page-two",
                  title: "Page Two",
                  startDate: { value: "2026-05-01T00:00:00.000Z" },
                  endDate: { value: "2026-05-20T00:00:00.000Z" },
                  storefrontMode: { value: "countdown_to_end" },
                  displayMode: null,
                  customMessage: null,
                  checkoutMode: { value: "inherit_storefront" },
                  checkoutMessage: null,
                }
              ]
            }
          }
        };
      }

      return {
        product: {
          collections: {
            pageInfo: { hasNextPage: true, endCursor: String(variables.after ?? "cursor") + "-next" },
            nodes: []
          }
        }
      };
    }\n`,
    "utf8",
  );

  const servicePath = await transpileToTemp("app/services/checkout-schedule.server.ts");
  const service = await import(pathToFileURL(servicePath).href);
  const now = new Date("2026-05-13T12:00:00.000Z");

  assert.equal(
    service.selectCheckoutSchedule(
      [
        {
          handle: "orders",
          title: "Orders",
          storefrontMode: "countdown_to_end",
          displayMode: null,
          customMessage: null,
          checkoutMode: "countdown_to_end",
          checkoutMessage: null,
          startDate: "2026-05-01T00:00:00.000Z",
          endDate: "2026-05-20T00:00:00.000Z",
        },
        {
          handle: "notice",
          title: "Notice",
          storefrontMode: "countdown_to_end",
          displayMode: null,
          customMessage: null,
          checkoutMode: "message",
          checkoutMessage: "Checkout closes soon.",
          startDate: "2026-05-01T00:00:00.000Z",
          endDate: "2026-05-19T00:00:00.000Z",
        },
      ],
      now,
    ).mode,
    "message",
  );

  assert.deepEqual(
    service.selectCheckoutSchedule(
      [
        {
          handle: "inherited",
          title: "Inherited",
          storefrontMode: "message",
          displayMode: null,
          customMessage: "Storefront message.",
          checkoutMode: "inherit_storefront",
          checkoutMessage: "",
          startDate: null,
          endDate: null,
        },
      ],
      now,
    ),
    {
      mode: "message",
      endDate: null,
      message: "Storefront message.",
      serverTime: now.toISOString(),
    },
  );

  assert.deepEqual(
    service.selectCheckoutSchedule(
      [
        {
          handle: "later",
          title: "Later",
          storefrontMode: "countdown_to_end",
          displayMode: null,
          customMessage: null,
          checkoutMode: "inherit_storefront",
          checkoutMessage: null,
          startDate: "2026-05-01T00:00:00.000Z",
          endDate: "2026-05-25T00:00:00.000Z",
        },
        {
          handle: "earlier",
          title: "Earlier",
          storefrontMode: "none",
          displayMode: null,
          customMessage: null,
          checkoutMode: "countdown_to_end",
          checkoutMessage: null,
          startDate: "2026-05-01T00:00:00.000Z",
          endDate: "2026-05-18T00:00:00.000Z",
        },
      ],
      now,
    ).endDate,
    "2026-05-18T00:00:00.000Z",
  );

  assert.equal(
    service.selectCheckoutSchedule(
      [
        {
          handle: "starts-later",
          title: "Starts Later",
          storefrontMode: "countdown_to_end",
          displayMode: null,
          customMessage: null,
          checkoutMode: "inherit_storefront",
          checkoutMessage: null,
          startDate: "2026-05-18T00:00:00.000Z",
          endDate: "2026-05-20T00:00:00.000Z",
        },
        {
          handle: "starts-sooner",
          title: "Starts Sooner",
          storefrontMode: "countdown_to_end",
          displayMode: null,
          customMessage: null,
          checkoutMode: "inherit_storefront",
          checkoutMessage: null,
          startDate: "2026-05-14T00:00:00.000Z",
          endDate: "2026-05-30T00:00:00.000Z",
        },
      ],
      now,
    ).endDate,
    "2026-05-30T00:00:00.000Z",
  );

  assert.equal(service.selectCheckoutSchedule([], now).mode, "none");
  assert.equal(
    service.selectCheckoutSchedule(
      [
        {
          handle: null,
          title: null,
          storefrontMode: "surprise",
          displayMode: "bad",
          customMessage: "",
          checkoutMode: "invalid",
          checkoutMessage: "",
          startDate: "nope",
          endDate: "also-nope",
        },
      ],
      now,
    ).mode,
    "none",
  );

  globalThis.__checkoutVerifyMode = "two-page";
  assert.equal(
    (
      await service.getCheckoutSchedule({
        shop: "example.myshopify.com",
        productIds: ["gid://shopify/Product/123"],
        now,
      })
    ).mode,
    "countdown_to_end",
  );

  globalThis.__checkoutVerifyMode = "overflow";
  await assert.rejects(
    service.getCheckoutSchedule({
      shop: "example.myshopify.com",
      productIds: ["gid://shopify/Product/123"],
      now,
    }),
    (error) => {
      assert.equal(error?.code, "collection_pagination_limit_exceeded");
      assert.equal(String(error.message).includes("gid://shopify"), false);
      return true;
    },
  );

  console.log("checkout schedule verification passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
