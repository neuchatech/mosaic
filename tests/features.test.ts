import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { createApp } from "../server/app";
import { heuristicAssistantPlan } from "../server/codex-assistant";
import { generateOutfits } from "../server/outfit-generator";
import { catalogMediaPath, catalogMediaType } from "../server/media";
import { setPublicNetworkTestHooksForTests } from "../server/public-html";
import { projectCompactCached } from "../server/projection-cache";
import { CatalogRepository } from "../server/repository";
import { findSimilarProducts } from "../server/similarity";
import { filterVisualCandidates } from "../server/visual-constraints";
import { createVisualAssessmentEventConsumer, rankVisualCandidates, visualCodexArgs } from "../server/visual-selection";
import { seedProducts } from "./fixtures/products";
import { productSchema, type Product } from "../src/domain/catalog";

const checkedAt = "2026-08-28T10:00:00.000Z";
const now = Date.parse("2026-08-28T12:00:00.000Z");

function checkedProduct(id: string, size: string, price: number, decision: Product["decision"] = "unseen") {
  return productSchema.parse({
    ...seedProducts[0],
    id,
    sourceId: id,
    price,
    sizes: [size],
    available: true,
    stockStatus: "in_stock",
    stockCheckedAt: checkedAt,
    priceCheckedAt: checkedAt,
    sizesCheckedAt: checkedAt,
    attributes: { ...seedProducts[0].attributes, sizeAvailabilityKnown: true },
    decision,
  });
}

test("visual constraints enforce exact fresh size, budget, kind, and rejection", () => {
  const products = [
    checkedProduct("m", "M", 99),
    checkedProduct("xl", "XL", 99),
    checkedProduct("expensive", "M", 180),
    checkedProduct("rejected", "M", 90, "rejected"),
    checkedProduct("saved", "M", 90, "saved"),
    checkedProduct("owned-shop", "M", 90, "owned"),
  ];
  const selected = filterVisualCandidates(products, { size: "M", maxPrice: 120, includeRejected: false, includeSaved: false }, now);
  assert.deepEqual(selected.map((product) => product.id), ["m"]);
  const withSaved = filterVisualCandidates(products, { size: "M", maxPrice: 120, includeRejected: false, includeSaved: true }, now);
  assert.deepEqual(withSaved.map((product) => product.id), ["m", "saved"]);
  const mediumOrLarge = filterVisualCandidates([
    ...products,
    checkedProduct("l", "L", 95),
    checkedProduct("s", "S", 95),
  ], { sizes: ["M", "L"], maxPrice: 120 }, now);
  assert.deepEqual(mediumOrLarge.map((product) => product.id), ["m", "l"]);
});

test("visual constraints enforce dynamic workspace fields", () => {
  const products = [
    productSchema.parse({ ...checkedProduct("oled", "M", 900), attributes: { panel: "OLED", refresh_rate: 120 } }),
    productSchema.parse({ ...checkedProduct("lcd", "M", 650), attributes: { panel: "LCD", refresh_rate: 60 } }),
  ];
  const selected = filterVisualCandidates(products, {
    where: {
      type: "group",
      conjunction: "and",
      children: [
        { type: "clause", field: "attributes.panel", operator: "eq", value: "OLED" },
        { type: "clause", field: "attributes.refresh_rate", operator: "gte", value: 100 },
      ],
    },
  }, now);
  assert.deepEqual(selected.map((product) => product.id), ["oled"]);
});

test("outfit generation prioritizes owned complementary garments and reports gaps", () => {
  const anchor = productSchema.parse({ ...seedProducts[0], id: "anchor", sourceId: "anchor", category: "Vestes", decision: "saved" });
  const top = productSchema.parse({ ...seedProducts[2], id: "owned-top", sourceId: "owned-top", kind: "owned", decision: "owned", category: "Mailles" });
  const bottom = productSchema.parse({ ...seedProducts[1], id: "owned-bottom", sourceId: "owned-bottom", kind: "owned", decision: "owned", category: "Pantalons" });
  const [outfit] = generateOutfits(anchor, [anchor, top, bottom], 1);
  assert.deepEqual(outfit.items.map((item) => item.productId), ["anchor", "owned-top", "owned-bottom"]);
  assert.deepEqual(outfit.missingRoles, ["shoes"]);
  assert.ok(outfit.compatibilityScore > 0);
});

test("projection cache reuses coordinates while preserving newer product metadata", () => {
  const initial = projectCompactCached(seedProducts);
  const renamed = seedProducts.map((product, index) => index === 0 ? { ...product, name: "Nouveau nom" } : product);
  const second = projectCompactCached(renamed);
  assert.equal(second[0].name, "Nouveau nom");
  assert.equal(second[0].x, initial[0].x);
  assert.equal(second[0].y, initial[0].y);
});

test("catalog API accepts mixed, visual-only, and metadata-only projections", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  repository.upsertProducts(seedProducts);
  const app = createApp(repository);
  try {
    for (const projection of ["hybrid", "visual", "metadata"] as const) {
      const response = await app.request(`/api/products?limit=100&projection=${projection}`);
      assert.equal(response.status, 200);
      const products = productSchema.array().parse(await response.json());
      assert.equal(products.length, seedProducts.length);
      assert.ok(products.every((product) => Number.isFinite(product.x) && Number.isFinite(product.y)));
    }
  } finally {
    db.close();
  }
});

test("Vision launches Codex with a read-only sandbox and approvals disabled", () => {
  const args = visualCodexArgs({ jobId: "job-test", referenceImages: ["/tmp/mood.jpg"], reasoningEffort: "medium" });
  assert.ok(!args.includes("--approve-for-me"));
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.ok(args.includes("approval_policy=\"never\""));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.some((value) => value.includes("WARDROBE_VISUAL_JOB_ID=\"job-test\"")));
  assert.deepEqual(args.slice(-3), ["--image", "/tmp/mood.jpg", "-"]);
});

test("the read-only visual runner persists only proposals made after a successful inspection", () => {
  const recorded: unknown[] = [];
  const consume = createVisualAssessmentEventConsumer("job-test", {
    recordVisualAssessment(input) { recorded.push(input); return {} as never; },
  });
  const event = (tool: string, args: object, error: unknown = null) => JSON.stringify({
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "wardrobe_atlas", tool, arguments: args, result: {}, error, status: error ? "failed" : "completed" },
  });
  const assessment = { jobId: "job-test", productId: "item-1", score: 0.82, rejected: false, reason: "Strong silhouette match", signals: ["wide", "brown"] };
  assert.equal(consume(event("propose_visual_assessment", assessment)), null);
  assert.equal(consume(event("inspect_visual_candidate", { jobId: "job-test", productId: "item-1" }, { message: "failed" })), null);
  assert.equal(consume(event("inspect_visual_candidate", { jobId: "job-test", productId: "item-1" })), "presented");
  assert.equal(consume(event("propose_visual_assessment", assessment)), "recorded");
  assert.equal(consume(event("inspect_visual_candidate", { jobId: "job-test", productId: "item-2" })), "presented");
  assert.equal(consume(event("propose_visual_assessment", {
    jobId: "job-test",
    productId: "item-2",
    score: 0.64,
    reason: "Useful texture match",
    signals: ["cable knit"],
  })), "recorded");
  assert.deepEqual(recorded, [assessment, {
    jobId: "job-test",
    productId: "item-2",
    score: 0.64,
    rejected: false,
    reason: "Useful texture match",
    signals: ["cable knit"],
  }]);
});

test("personal catalog media stays inside its dedicated local directory", () => {
  assert.match(catalogMediaPath("owned_abc-123", "1.webp"), /data\/media\/owned_abc-123\/1\.webp$/);
  assert.equal(catalogMediaType("1.webp"), "image/webp");
  assert.throws(() => catalogMediaPath("../escape", "1.jpg"));
  assert.throws(() => catalogMediaPath("owned_ok", "../../secret.jpg"));
});

test("scoped visual MCP does not expose global catalog enumeration tools", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wardrobe-scoped-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/index.ts"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      WARDROBE_DB_PATH: join(directory, "catalog.sqlite"),
      WARDROBE_VISUAL_JOB_ID: "visual-job-test",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "wardrobe-atlas-test", version: "0.1.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  await client.connect(transport);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  assert.ok(names.has("get_visual_job_context"));
  assert.ok(names.has("propose_visual_assessment"));
  assert.ok(!names.has("record_visual_assessment"));
  assert.ok(!names.has("catalog_stats"));
  assert.ok(!names.has("search_products"));
  assert.ok(!names.has("find_similar_products"));
  assert.ok(!names.has("import_public_product_links"));
});

test("legacy reference uploads persist image data outside SQLite", async (t) => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const app = createApp(repository);
  const mediaDirectories = new Set<string>();
  t.after(() => {
    db.close();
    for (const mediaDirectory of mediaDirectories) rmSync(mediaDirectory, { recursive: true, force: true });
  });

  const imageBytes = Buffer.from("reference-image-test");
  const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
  const response = await app.request("/api/references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Mood reference", images: [dataUrl] }),
  });
  assert.equal(response.status, 201);
  const product = productSchema.parse(await response.json());
  const mediaPath = catalogMediaPath(product.id, "1.png");
  mediaDirectories.add(dirname(mediaPath));
  assert.deepEqual(readFileSync(mediaPath), imageBytes);
  assert.equal(product.images[0], `/api/media/${product.id}/1.png`);
  assert.equal(product.stockStatus, "not_applicable");

  const row = db.prepare("SELECT images_json FROM products WHERE id = ?").get(product.id) as { images_json: string };
  assert.deepEqual(JSON.parse(row.images_json), product.images);
  assert.ok(!row.images_json.includes("data:image/"));

  const invalid = await app.request("/api/references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "", images: [dataUrl] }),
  });
  assert.equal(invalid.status, 400);
});

test("public Product JSON-LD URLs from a new shop can create catalog sheets", async (t) => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const app = createApp(repository);
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async (input) => {
      const url = input;
      const suffix = url.includes("second") ? "2" : "1";
      return new Response(`<!doctype html><script type="application/ld+json">{
      "@context":"https://schema.org/","@type":"Product","sku":"TEST-${suffix}",
      "name":"Cotton Cardigan ${suffix}","brand":{"name":"Independent Shop"},"color":"Dark Green",
      "image":["https://images.example.com/cardigan.jpg"],
      "offers":{"price":"129","priceCurrency":"CHF","availability":"https://schema.org/InStock"}
    }</script>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  t.after(() => {
    setPublicNetworkTestHooksForTests(null);
    db.close();
  });

  const response = await app.request("/api/products/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://shop.example.com/products/first" }),
  });
  assert.equal(response.status, 201);
  const product = productSchema.parse(await response.json());
  assert.equal(product.source, "generic-shop-example-com");
  assert.equal(product.name, "Cotton Cardigan 1");
  assert.equal(product.price, 129);
  assert.equal(repository.getProduct(product.id)?.decision, "unseen");

  const batch = await app.request("/api/products/import-urls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: [
      "https://shop.example.com/products/first",
      "https://shop.example.com/products/second",
      "https://127.0.0.1/private-product",
    ] }),
  });
  assert.equal(batch.status, 201);
  const batchResult = await batch.json() as { products: Product[]; errors: Array<{ url: string; error: string }> };
  assert.deepEqual(batchResult.products.map((item) => item.name), ["Cotton Cardigan 1", "Cotton Cardigan 2"]);
  assert.equal(batchResult.errors.length, 1);

  const rejected = await app.request("/api/products/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://127.0.0.1/private-product" }),
  });
  assert.equal(rejected.status, 400);
});

test("assistant defaults can be replaced by explicit sizes and route catalog anchors to similarity", () => {
  const plan = heuristicAssistantPlan({
    prompt: "Trouve des alternatives similaires en tailles XL ou XXL",
    imageCount: 0,
    productIds: ["anchor"],
    links: [],
    defaults: { sizes: ["M", "L"], shops: ["zalando-ch"] },
  });
  assert.equal(plan.action, "similar");
  assert.equal(plan.sizePolicy, "explicit");
  assert.deepEqual(plan.effectiveSizes, ["XL", "XXL"]);
});

test("similar products use catalog coordinates when a CLIP vector is not cached", async (t) => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  t.after(() => db.close());
  const products = [
    productSchema.parse({ ...seedProducts[0], id: "anchor-local", sourceId: "anchor-local", x: .1, y: .1 }),
    productSchema.parse({ ...seedProducts[1], id: "nearest-local", sourceId: "nearest-local", decision: "unseen", x: .12, y: .13 }),
    productSchema.parse({ ...seedProducts[2], id: "far-local", sourceId: "far-local", decision: "unseen", x: .9, y: .9 }),
  ];
  repository.upsertProducts(products);
  const similar = await findSimilarProducts({ productIds: ["anchor-local"], limit: 2 }, repository);
  assert.deepEqual(similar.map((item) => item.id), ["nearest-local", "far-local"]);
  assert.match(String(similar[0]?.attributes.selectionReason), /projection locale/);
});

test("visual candidate preselection ranks by local CLIP similarity and stays bounded", () => {
  const products = [
    productSchema.parse({ ...seedProducts[0], id: "visual-near", sourceId: "visual-near" }),
    productSchema.parse({ ...seedProducts[1], id: "visual-far", sourceId: "visual-far" }),
    productSchema.parse({ ...seedProducts[2], id: "visual-missing", sourceId: "visual-missing" }),
  ];
  const ranked = rankVisualCandidates(products, new Map([
    ["visual-near", [1, 0]],
    ["visual-far", [0, 1]],
  ]), [[1, 0]], 2);
  assert.deepEqual(ranked.map(({ id }) => id), ["visual-near", "visual-far"]);
});

test("visual preselection round-robins multiple reference views instead of letting one crop dominate", () => {
  const products = [
    productSchema.parse({ ...seedProducts[0], id: "whole-first", sourceId: "whole-first" }),
    productSchema.parse({ ...seedProducts[1], id: "crop-first", sourceId: "crop-first" }),
    productSchema.parse({ ...seedProducts[2], id: "whole-second", sourceId: "whole-second" }),
  ];
  const ranked = rankVisualCandidates(products, new Map([
    ["whole-first", [1, 0]],
    ["crop-first", [0, 1]],
    ["whole-second", [.8, .2]],
  ]), [[1, 0], [0, 1]], 2);
  assert.deepEqual(ranked.map(({ id }) => id), ["whole-first", "crop-first"]);
});
