import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const rootDir = process.cwd();
const contractPath = path.join(rootDir, "app/services/schedule-contract.ts");

async function importContract() {
  const source = await readFile(contractPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName: contractPath,
  });

  const encodedSource = Buffer.from(
    `${transpiled.outputText}\n//# sourceURL=${pathToFileURL(contractPath).href}`,
    "utf8",
  ).toString("base64");

  return import(`data:text/javascript;base64,${encodedSource}`);
}

const contract = await importContract();

assert.deepEqual(contract.AVAILABILITY_MODES, ["managed", "always_live", "none"]);
assert.deepEqual(contract.STOREFRONT_MODES, ["none", "countdown_to_end", "message"]);
assert.deepEqual(contract.CHECKOUT_MODES, [
  "inherit_storefront",
  "none",
  "countdown_to_end",
  "message",
]);
assert.equal(contract.legacyDisplayModeToStorefrontMode("countdown"), "countdown_to_end");
assert.equal(contract.legacyDisplayModeToStorefrontMode("message"), "message");
assert.equal(contract.legacyDisplayModeToStorefrontMode("none"), "none");
assert.equal(contract.storefrontModeToLegacyDisplayMode("countdown_to_end"), "countdown");
assert.equal(contract.resolveEffectiveCheckoutMode("inherit_storefront", "message"), "message");
assert.equal(contract.resolveEffectiveCheckoutMode("none", "message"), "none");

console.log("schedule contract verification passed");
