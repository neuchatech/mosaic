import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { createApp } from "../server/app";
import { setPublicNetworkTestHooksForTests } from "../server/public-html";
import { CatalogRepository } from "../server/repository";
import type { Product } from "../src/domain/catalog";

function memoryRepository() {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  return { db, repository: new CatalogRepository(db) };
}

test("V1 API isolates workspaces, infers generic fields, and persists collections/artifacts", async (t) => {
  const { db, repository } = memoryRepository();
  const app = createApp(repository);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async (input) => {
      const url = new URL(input);
      const ordinal = Number(url.pathname.match(/(\d+)$/)?.[1] ?? 1);
      return new Response(`<!doctype html><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        sku: `TV-${ordinal}`,
        name: `OLED Television ${ordinal}`,
        category: "Televisions",
        brand: { name: "Example Vision" },
        image: [`https://images.example.com/tv-${ordinal}.jpg`],
        additionalProperty: [
          { "@type": "PropertyValue", name: "Screen size", value: `${40 + ordinal * 5} in` },
          { "@type": "PropertyValue", name: "Refresh rate", value: `${60 + ordinal * 30} Hz` },
        ],
        offers: { price: String(800 + ordinal * 100), priceCurrency: "CHF", availability: "https://schema.org/InStock" },
      })}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  t.after(() => {
    setPublicNetworkTestHooksForTests(null);
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    db.close();
  });

  const created = await app.request("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Living-room TVs", profile: "televisions" }),
  });
  assert.equal(created.status, 201);
  const workspace = await created.json() as { id: string; profile: string };
  assert.equal(workspace.profile, "televisions");

  const imported = await app.request("/api/products/import-urls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: workspace.id,
      urls: [1, 2, 3].map((id) => `https://shop.example.com/products/${id}`),
    }),
  });
  assert.equal(imported.status, 201);
  const importedBody = await imported.json() as { products: Product[] };
  assert.equal(importedBody.products.length, 3);
  assert.ok(importedBody.products.every((product) => product.workspaceId === workspace.id));
  assert.ok(importedBody.products.every((product) => product.category === "Televisions"));
  assert.equal(importedBody.products[0]?.attributes.screen_size, 45);
  assert.equal(importedBody.products[0]?.attributes.refresh_rate, 90);

  const defaultProducts = await (await app.request("/api/products?workspaceId=default-clothing")).json() as Product[];
  const tvProducts = await (await app.request(`/api/products?workspaceId=${workspace.id}`)).json() as Product[];
  assert.equal(defaultProducts.length, 0);
  assert.equal(tvProducts.length, 3);

  const uiSchemaResponse = await app.request(`/api/workspaces/current/ui-schema?workspaceId=${workspace.id}`);
  assert.equal(uiSchemaResponse.status, 200);
  const uiSchema = await uiSchemaResponse.json() as {
    inferred: boolean;
    workspace: { schemaVersion: number };
    fields: Array<{ key: string; type: string; unit: string | null }>;
    facets: Record<string, unknown[]>;
  };
  assert.equal(uiSchema.inferred, false);
  assert.equal(uiSchema.workspace.schemaVersion, 2);
  assert.equal(uiSchema.fields.find((field) => field.key === "attributes.screen_size")?.type, "number");
  assert.equal(uiSchema.fields.find((field) => field.key === "attributes.refresh_rate")?.type, "number");
  assert.ok(Array.isArray(uiSchema.facets["attributes.screen_size"]));

  const stableFieldKeys = uiSchema.fields.map((field) => field.key);
  repository.upsertProducts(Array.from({ length: 6 }, (_, index) => ({
    ...importedBody.products[0]!,
    id: `stable-schema-tv-${index}`,
    sourceId: `STABLE-SCHEMA-${index}`,
    url: `https://shop.example.com/products/stable-schema-${index}`,
    name: `Later television ${index}`,
    attributes: {
      ...importedBody.products[0]!.attributes,
      aaa_input_lag: 5 + index,
    },
  })));
  const stableSchemaResponse = await app.request(`/api/workspaces/current/ui-schema?workspaceId=${workspace.id}`);
  assert.equal(stableSchemaResponse.status, 200);
  const stableSchema = await stableSchemaResponse.json() as {
    workspace: { schemaVersion: number };
    fields: Array<{ key: string }>;
  };
  assert.equal(stableSchema.workspace.schemaVersion, uiSchema.workspace.schemaVersion);
  assert.deepEqual(stableSchema.fields.map((field) => field.key), stableFieldKeys);
  assert.ok(!stableSchema.fields.some((field) => field.key === "attributes.aaa_input_lag"));

  const collectionResponse = await app.request("/api/collections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, name: "Finalists", type: "manual" }),
  });
  assert.equal(collectionResponse.status, 201);
  const collection = await collectionResponse.json() as { id: string };
  const membership = await app.request(`/api/collections/${collection.id}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: workspace.id,
      itemIds: importedBody.products.slice(0, 2).map((product) => product.id),
    }),
  });
  assert.equal(membership.status, 200);
  assert.deepEqual((await membership.json() as { itemIds: string[] }).itemIds, importedBody.products.slice(0, 2).map((product) => product.id));

  const assistant = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: workspace.id,
      productIds: [importedBody.products[0]!.id],
      prompt: "Crée un brouillon de mood board pour ce téléviseur",
    }),
  });
  assert.equal(assistant.status, 201);
  const assistantBody = await assistant.json() as { action: string; artifact: { status: string; inputItemIds: string[] } };
  assert.equal(assistantBody.action, "artifact");
  assert.equal(assistantBody.artifact.status, "draft");
  assert.deepEqual(assistantBody.artifact.inputItemIds, [importedBody.products[0]!.id]);
});

test("global Mosaic MCP exposes bounded browser handoff tools while scoped Vision does not", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-v1-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/index.ts"],
    cwd: process.cwd(),
    env: { ...getDefaultEnvironment(), WARDROBE_DB_PATH: join(directory, "catalog.sqlite") },
    stderr: "pipe",
  });
  const client = new Client({ name: "mosaic-v1-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  await client.connect(transport);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of [
    "list_workspaces", "get_workspace_ui_schema", "list_collections", "create_collection",
    "add_items_to_collection", "import_extracted_items", "start_catalog_discovery",
  ]) assert.ok(names.has(name), `missing MCP tool ${name}`);

  const result = await client.callTool({
    name: "import_extracted_items",
    arguments: {
      workspaceId: "default-clothing",
      items: [{
        url: "https://shop.example.com/product/browser-1",
        source: "browser-shop-example",
        name: "Browser factual item",
        category: "Accessories",
        price: 49,
        images: ["../images/browser-1.jpg"],
        sizes: [],
        stockStatus: "unknown",
        sizeAvailabilityKnown: false,
        attributes: { extracted_label: "public page" },
      }],
    },
  });
  assert.equal(result.isError, undefined);
  const imported = (result.structuredContent as {
    result: { imported: number; products: Product[] };
  }).result;
  assert.equal(imported.imported, 1);
  assert.deepEqual(imported.products[0]?.images, ["https://shop.example.com/images/browser-1.jpg"]);

  const unsafe = await client.callTool({
    name: "import_extracted_items",
    arguments: {
      workspaceId: "default-clothing",
      items: [{
        url: "https://shop.example.com/product/local-file",
        name: "Unsafe browser item",
        images: ["file:///etc/passwd"],
      }],
    },
  });
  assert.equal(unsafe.isError, true);
  const unsafeContent = unsafe.content as Array<{ type: string; text?: string }>;
  assert.match(String(unsafeContent[0]?.text ?? ""), /public HTTPS product images/i);
});
