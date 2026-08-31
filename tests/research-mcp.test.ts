import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { buildResearchManifest } from "../server/research-context";
import { migrateDatabase } from "../server/database";
import { CatalogRepository } from "../server/repository";
import {
  researchBudgetFromEnvironment,
  researchScopeFromEnvironment,
  sampleWorkspaceProducts,
  sourceCapabilities,
} from "../mcp/research-tools";
import { productSchema, type Product } from "../src/domain/catalog";
import { researchRequestSchema } from "../src/domain/research";

const workspaceA = "research-a";
const workspaceB = "research-b";
const runId = "research-mcp-run";

function item(input: Partial<Product> & Pick<Product, "id" | "workspaceId" | "name" | "x" | "y">): Product {
  const timestamp = input.updatedAt ?? "2026-08-30T12:00:00.000Z";
  return productSchema.parse({
    source: "fixture-source",
    sourceId: input.id,
    url: `https://example.com/${input.id}`,
    brand: "Fixture",
    description: "A generic visual research fixture",
    price: 100,
    originalPrice: null,
    currency: "CHF",
    category: "Objects",
    color: "Neutral",
    colorFamily: "neutral",
    fit: "unknown",
    attributes: {},
    materials: [],
    tags: [],
    sizes: [],
    images: [],
    available: true,
    decision: "unseen",
    scores: {},
    importedAt: timestamp,
    updatedAt: timestamp,
    ...input,
  });
}

function seedResearchDatabase(
  databasePath: string,
  budget: Record<string, number> = {},
  images: Array<{ name: string; mediaPath: string; mimeType: string }> = [],
) {
  const db = new Database(databasePath);
  migrateDatabase(db);
  const repository = new CatalogRepository(db);
  repository.createWorkspace({ id: workspaceA, name: "First workspace", profile: "generic" });
  repository.createWorkspace({ id: workspaceB, name: "Second workspace", profile: "generic" });
  repository.upsertProducts([
    item({ id: "a-one", workspaceId: workspaceA, name: "Alpha one", x: 0.1, y: 0.2, attributes: { texture: "woven" } }),
    item({ id: "a-two", workspaceId: workspaceA, name: "Alpha two", x: 0.8, y: 0.7, price: 500, attributes: { texture: "woven" }, updatedAt: "2026-08-31T12:00:00.000Z" }),
    item({ id: "a-three", workspaceId: workspaceA, name: "Beta three", x: 0.45, y: 0.5, embeddingRevision: "clip-v1" }),
    item({ id: "b-secret", workspaceId: workspaceB, name: "Foreign secret", x: 0.5, y: 0.5 }),
  ]);
  const request = researchRequestSchema.parse({
    workspaceId: workspaceA,
    prompt: "Find varied visual evidence without assuming an item domain.",
    itemIds: ["a-three"],
    constraints: [
      { field: "price", operator: "lte", value: 200, strength: "hard" },
      { field: "attributes.texture", operator: "contains", value: "woven", strength: "hard" },
      { field: "category", operator: "eq", value: "Objects", strength: "soft" },
    ],
    images,
    budget,
    reasoningEffort: "medium",
  });
  const manifest = buildResearchManifest(request, repository);
  repository.createResearchRun({
    id: runId,
    workspaceId: workspaceA,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    request,
    manifest,
  });
  db.close();
  return request;
}

async function connectResearchClient(
  t: test.TestContext,
  databasePath: string,
  budget: Record<string, number> = {},
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/index.ts"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      WARDROBE_DB_PATH: databasePath,
      MOSAIC_RESEARCH_RUN_ID: runId,
      MOSAIC_RESEARCH_WORKSPACE_ID: workspaceA,
      MOSAIC_RESEARCH_BUDGET_JSON: JSON.stringify(budget),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mosaic-research-test", version: "1.0.0" });
  t.after(async () => client.close().catch(() => undefined));
  await client.connect(transport);
  return client;
}

function dataFrom(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (result.structuredContent as { result?: { data?: unknown } } | undefined)?.result?.data;
}

test("research scope and budget environment require a complete, validated pair", () => {
  assert.equal(researchScopeFromEnvironment({}), null);
  assert.deepEqual(researchScopeFromEnvironment({
    MOSAIC_RESEARCH_RUN_ID: "run-one",
    MOSAIC_RESEARCH_WORKSPACE_ID: "workspace-one",
  }), { runId: "run-one", workspaceId: "workspace-one" });
  assert.throws(() => researchScopeFromEnvironment({ MOSAIC_RESEARCH_RUN_ID: "run-one" }), /must be set together/);
  assert.equal(researchBudgetFromEnvironment({ MOSAIC_RESEARCH_BUDGET_JSON: '{"maxToolCalls":7}' }).maxToolCalls, 7);
  assert.throws(() => researchBudgetFromEnvironment({ MOSAIC_RESEARCH_BUDGET_JSON: "{" }), /Invalid/);
});

test("research sampling is bounded, deterministic, and supports every generic strategy", () => {
  const products = [
    item({ id: "one", workspaceId: workspaceA, name: "One", x: 0, y: 0 }),
    item({ id: "two", workspaceId: workspaceA, name: "Two", x: 0.1, y: 0.1, embeddingRevision: "v1" }),
    item({ id: "three", workspaceId: workspaceA, name: "Three", x: 0.9, y: 0.9, updatedAt: "2026-08-31T12:00:00.000Z" }),
    item({ id: "four", workspaceId: workspaceA, name: "Four", x: 1, y: 0, source: "other-source", category: "Other" }),
    item({ id: "five", workspaceId: workspaceA, name: "Five", x: 0, y: 1 }),
  ];
  for (const strategy of ["diverse", "recent", "outliers", "uncertain", "random", "cluster"] as const) {
    const first = sampleWorkspaceProducts({ products, strategy, limit: 3, seed: "fixed" });
    const second = sampleWorkspaceProducts({ products, strategy, limit: 3, seed: "fixed" });
    assert.equal(first.products.length, 3, strategy);
    assert.deepEqual(first.products.map(({ id }) => id), second.products.map(({ id }) => id), strategy);
    assert.equal(new Set(first.products.map(({ id }) => id)).size, 3, strategy);
    if (strategy === "cluster") assert.ok(first.clusters.length > 1);
  }
});

test("source capabilities describe mechanisms without hard-coding a research domain", () => {
  const capabilities = sourceCapabilities();
  assert.ok(capabilities.sources.some((source) => source.operations.includes("discover")));
  assert.equal(capabilities.genericPublicItemImport.available, true);
  const interactive = capabilities.sources.find((source) => source.id === "interactive-browser");
  assert.equal(interactive?.availability, "unavailable");
  assert.match(interactive?.availabilityReason ?? "", /background Codex CLI/i);
  assert.doesNotMatch(JSON.stringify(capabilities), /garment|television/i);
});

test("research MCP exposes only scoped tools and preserves manifest constraints", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-research-mcp-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  seedResearchDatabase(databasePath, { maxToolCalls: 20, maxItemsRead: 20, maxImageInspections: 4 });
  const client = await connectResearchClient(t, databasePath, {
    maxToolCalls: 20,
    maxItemsRead: 20,
    maxImageInspections: 4,
  });

  const tools = (await client.listTools()).tools;
  const names = new Set(tools.map(({ name }) => name));
  for (const expected of [
    "get_research_context",
    "query_workspace_items",
    "sample_workspace_items",
    "get_source_capabilities",
    "find_similar_workspace_items",
    "rank_workspace_by_visual_references",
    "inspect_workspace_item",
    "build_workspace_contact_sheet",
    "list_workspace_collections",
    "create_workspace_collection",
    "add_workspace_items_to_collection",
    "annotate_workspace_items",
    "import_workspace_links",
    "start_source_discovery",
  ]) assert.ok(names.has(expected), `missing research tool ${expected}`);
  for (const hidden of [
    "list_workspaces",
    "catalog_stats",
    "search_products",
    "inspect_product_image",
    "get_visual_job_context",
    "record_visual_assessment",
    "annotate_products",
  ]) assert.ok(!names.has(hidden), `research scope leaked tool ${hidden}`);
  for (const tool of tools) {
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(!("workspaceId" in properties), `${tool.name} allows caller-selected workspaceId`);
  }

  const contextResult = await client.callTool({ name: "get_research_context", arguments: {} });
  assert.notEqual(contextResult.isError, true);
  const context = dataFrom(contextResult) as {
    run: { id: string; workspaceId: string };
    manifest: { workspace: { id: string }; constraints: Array<{ field: string }> };
  };
  assert.equal(context.run.id, runId);
  assert.equal(context.run.workspaceId, workspaceA);
  assert.equal(context.manifest.workspace.id, workspaceA);
  assert.deepEqual(context.manifest.constraints.map(({ field }) => field), [
    "price", "attributes.texture", "category",
  ]);
});

test("query, sample, and similarity cannot return candidates outside hard dynamic constraints", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-research-hard-filter-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  seedResearchDatabase(databasePath, { maxToolCalls: 20, maxItemsRead: 30 });
  const client = await connectResearchClient(t, databasePath, { maxToolCalls: 20, maxItemsRead: 30 });

  const query = dataFrom(await client.callTool({
    name: "query_workspace_items",
    arguments: { limit: 20 },
  })) as { items: Array<{ id: string }> };
  assert.deepEqual(query.items.map(({ id }) => id), ["a-one"]);

  const sample = dataFrom(await client.callTool({
    name: "sample_workspace_items",
    arguments: { strategy: "random", limit: 20 },
  })) as { items: Array<{ id: string }> };
  assert.deepEqual(sample.items.map(({ id }) => id), ["a-one"]);

  const similar = dataFrom(await client.callTool({
    name: "find_similar_workspace_items",
    arguments: { itemIds: ["a-one"], limit: 20 },
  })) as Array<{ id: string }>;
  assert.deepEqual(similar, []);

  const visualResult = await client.callTool({
    name: "rank_workspace_by_visual_references",
    arguments: { contextItemIds: ["a-three"], limit: 20 },
  });
  assert.notEqual(visualResult.isError, true, JSON.stringify(visualResult.content));
  const visual = dataFrom(visualResult) as { items: Array<{ id: string; visualRetrieval: { mode: string; score: number } }> };
  assert.deepEqual(visual.items.map(({ id }) => id), ["a-one"]);
  assert.match(visual.items[0]!.visualRetrieval.mode, /catalog-order|pca-coordinate|clip-/);
  assert.ok(visual.items[0]!.visualRetrieval.score >= 0);
});

test("research MCP cannot query, inspect, collect, or annotate across workspaces", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-research-isolation-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  seedResearchDatabase(databasePath, { maxToolCalls: 30, maxItemsRead: 30, maxCollectionWrites: 3 });
  const client = await connectResearchClient(t, databasePath, {
    maxToolCalls: 30,
    maxItemsRead: 30,
    maxCollectionWrites: 3,
  });

  const query = await client.callTool({
    name: "query_workspace_items",
    arguments: {
      filter: {
        id: "foreign-workspace",
        name: "Foreign workspace",
        where: { type: "clause", field: "workspaceId", operator: "eq", value: workspaceB },
        limit: 20,
      },
      limit: 20,
    },
  });
  const queried = dataFrom(query) as { items: Array<{ id: string }> };
  assert.deepEqual(queried.items, []);

  const inspect = await client.callTool({
    name: "inspect_workspace_item",
    arguments: { itemId: "b-secret" },
  });
  assert.equal(inspect.isError, true);
  const create = await client.callTool({
    name: "create_workspace_collection",
    arguments: { name: "Leaky selection", itemIds: ["b-secret"] },
  });
  assert.equal(create.isError, true);
  const annotate = await client.callTool({
    name: "annotate_workspace_items",
    arguments: { itemIds: ["b-secret"], patch: { tags: ["leaked"] } },
  });
  assert.equal(annotate.isError, true);

  await client.close();
  const verifyDb = new Database(databasePath);
  t.after(() => verifyDb.close());
  migrateDatabase(verifyDb);
  assert.deepEqual(new CatalogRepository(verifyDb).getProduct("b-secret", workspaceB)?.tags, []);
});

test("visual-reference retrieval reserves the run image-inspection budget before encoding", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-research-image-budget-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const budget = { maxToolCalls: 10, maxItemsRead: 10, maxImageInspections: 0 };
  seedResearchDatabase(databasePath, budget, [{
    name: "Reference",
    mediaPath: "/api/media/research-fixture/1.jpg",
    mimeType: "image/jpeg",
  }]);
  const client = await connectResearchClient(t, databasePath, budget);

  const result = await client.callTool({
    name: "rank_workspace_by_visual_references",
    arguments: { limit: 5 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.match(String(content[0]?.text ?? ""), /budget exhausted: imageInspections/i);
});

test("research MCP rejects further reads when the process-local item budget is exhausted", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mosaic-research-budget-"));
  const databasePath = join(directory, "catalog.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const budget = { maxToolCalls: 10, maxItemsRead: 2, maxImageInspections: 0 };
  seedResearchDatabase(databasePath, budget);
  const client = await connectResearchClient(t, databasePath, budget);

  const first = await client.callTool({
    name: "query_workspace_items",
    arguments: { limit: 2 },
  });
  assert.notEqual(first.isError, true);
  const firstPayload = first.structuredContent as {
    result: { budget: { used: { itemsRead: number } } };
  };
  assert.equal(firstPayload.result.budget.used.itemsRead, 1);

  const second = await client.callTool({
    name: "query_workspace_items",
    arguments: { limit: 1 },
  });
  assert.notEqual(second.isError, true);

  const exhausted = await client.callTool({
    name: "query_workspace_items",
    arguments: { limit: 1 },
  });
  assert.equal(exhausted.isError, true);
  const content = exhausted.content as Array<{ type: string; text?: string }>;
  assert.match(String(content[0]?.text ?? ""), /budget exhausted: itemsRead/i);
});
