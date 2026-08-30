import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { normalizeProduct } from "../collector/normalize";
import { migrateDatabase } from "../server/database";
import { CatalogRepository } from "../server/repository";
import { stableWorkspaceProductId } from "../src/domain/ids";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

const otherWorkspaceId = "televisions";
const source = "zalando-ch";
const rawSourceId = "shared-browser-source-id";
const url = "https://www.zalando.ch/shared-browser-product.html";
const image = "https://img01.ztat.net/article/shared-browser-product.jpg";

test("MCP browser extraction is idempotent with collector identity in default and non-default workspaces", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-mcp-identity-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const collectorRaw = {
    sourceId: rawSourceId,
    url,
    brand: "Identity",
    name: "Collector observation",
    price: 99,
    currency: "CHF",
    category: "Vestes",
    images: [image],
  };
  const defaultCollectorProduct = normalizeProduct(source, collectorRaw, DEFAULT_CLOTHING_WORKSPACE_ID);
  const otherCollectorProduct = normalizeProduct(source, collectorRaw, otherWorkspaceId);

  const seedDb = new Database(databasePath);
  migrateDatabase(seedDb);
  const seedRepository = new CatalogRepository(seedDb);
  seedRepository.createWorkspace({ id: otherWorkspaceId, name: "Televisions", profile: "televisions" });
  seedRepository.upsertCollectedProducts([defaultCollectorProduct]);
  seedRepository.setDecision([defaultCollectorProduct.id], "saved", DEFAULT_CLOTHING_WORKSPACE_ID);
  seedDb.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/index.ts"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      WARDROBE_DB_PATH: databasePath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mosaic-identity-test", version: "1.0.0" });
  let connected = false;
  t.after(async () => {
    if (connected) await client.close().catch(() => undefined);
  });
  await client.connect(transport);
  connected = true;

  const extracted = {
    source,
    sourceId: rawSourceId,
    url,
    brand: "Identity",
    name: "Browser observation",
    price: 99,
    currency: "CHF",
    category: "Vestes",
    images: [image],
    stockStatus: "unknown",
    sizeAvailabilityKnown: false,
  };
  for (const workspaceId of [DEFAULT_CLOTHING_WORKSPACE_ID, otherWorkspaceId]) {
    const result = await client.callTool({
      name: "import_extracted_items",
      arguments: { workspaceId, items: [extracted] },
    });
    assert.notEqual(result.isError, true);
  }
  await client.close();
  connected = false;

  const verifyDb = new Database(databasePath);
  t.after(() => verifyDb.close());
  migrateDatabase(verifyDb);
  const repository = new CatalogRepository(verifyDb);

  const defaultProducts = repository.listProducts({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID });
  const otherProductsBeforeCollector = repository.listProducts({ workspaceId: otherWorkspaceId });
  assert.equal(defaultProducts.length, 1);
  assert.equal(otherProductsBeforeCollector.length, 1);
  assert.equal(defaultProducts[0]?.id, defaultCollectorProduct.id);
  assert.equal(defaultProducts[0]?.sourceId, rawSourceId);
  assert.equal(defaultProducts[0]?.decision, "saved");
  assert.equal(otherProductsBeforeCollector[0]?.id, otherCollectorProduct.id);
  assert.equal(otherProductsBeforeCollector[0]?.sourceId, rawSourceId);

  repository.setDecision([otherCollectorProduct.id], "saved", otherWorkspaceId);
  repository.upsertCollectedProducts([otherCollectorProduct]);
  const otherProductsAfterCollector = repository.listProducts({ workspaceId: otherWorkspaceId });
  assert.equal(otherProductsAfterCollector.length, 1);
  assert.equal(otherProductsAfterCollector[0]?.id, stableWorkspaceProductId(otherWorkspaceId, source, rawSourceId));
  assert.equal(otherProductsAfterCollector[0]?.sourceId, rawSourceId);
  assert.equal(otherProductsAfterCollector[0]?.decision, "saved");
  assert.notEqual(defaultProducts[0]?.id, otherProductsAfterCollector[0]?.id);
});
