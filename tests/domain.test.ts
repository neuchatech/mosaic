import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CatalogRepository } from "../server/repository";
import { convertCodexNode } from "../server/codex-bridge";
import { seedProducts } from "../src/catalog/seed";
import { filterSpecSchema } from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { normalizeZalandoSizes } from "../collector/adapters/zalando";

test("nested filters can inspect standard, dynamic, and negated criteria", () => {
  const filter = filterSpecSchema.parse({
    id: "test",
    name: "complex",
    where: {
      type: "group",
      conjunction: "and",
      children: [
        { type: "clause", field: "colorFamily", operator: "in", value: ["brown", "beige"] },
        { type: "not", child: { type: "clause", field: "tags", operator: "contains", value: "sportswear" } },
        { type: "clause", field: "scores.style_match", operator: "gte", value: 85 },
        { type: "clause", field: "attributes.season", operator: "eq", value: "autumn-winter" }
      ]
    },
    limit: 100
  });
  const result = applyFilter(seedProducts, filter);
  assert.deepEqual(result.map((product) => product.id), ["seed_1", "seed_2", "seed_3"]);
});

test("numeric filters do not treat a missing reference price as zero", () => {
  const reference = { ...seedProducts[0], id: "reference", kind: "reference" as const, price: null };
  const filter = filterSpecSchema.parse({
    id: "price",
    name: "priced",
    where: { type: "clause", field: "price", operator: "lte", value: 180 },
    limit: 100
  });
  assert.equal(applyFilter([reference], filter).length, 0);
});

test("Zalando size capture keeps only available-looking garment sizes", () => {
  assert.deepEqual(
    normalizeZalandoSizes(["Taille: M", "XL disponible", "Choisir une taille", "48", "M", "EU 50"]),
    ["M", "XL", "48", "EU 50"],
  );
});

test("size filters match the recorded available sizes", () => {
  const products = seedProducts.slice(0, 2).map((product, index) => ({
    ...product,
    sizes: index === 0 ? ["S", "M"] : ["XL"],
  }));
  const filter = filterSpecSchema.parse({
    id: "size-m",
    name: "M disponible",
    where: { type: "clause", field: "sizes", operator: "contains", value: "M" },
  });
  assert.deepEqual(applyFilter(products, filter).map((product) => product.id), [products[0].id]);
});

test("compact projection assigns one in-bounds cell per visible product", () => {
  const compact = compactProjection(seedProducts);
  assert.equal(compact.length, seedProducts.length);
  const positions = new Set(compact.map((product) => `${product.x}:${product.y}`));
  assert.equal(positions.size, compact.length);
  assert.ok(compact.every((product) => product.x >= 0 && product.x <= 1 && product.y >= 0 && product.y <= 1));
});

test("PCA projection tolerates a corpus with constant feature dimensions", () => {
  const identical = seedProducts.slice(0, 3).map((product, index) => ({
    ...seedProducts[0],
    id: `constant_${index}`,
    sourceId: `constant_${index}`,
    price: 100,
  }));
  const projected = projectProducts(identical);
  assert.equal(projected.length, 3);
  assert.ok(projected.every((product) => product.x === .5 && product.y === .5));
});

test("Codex filter conversion removes placeholder clauses from groups", () => {
  const neutral = {
    conjunction: "none" as const,
    valueKind: "none" as const,
    stringValues: [],
    numberValues: [],
    booleanValue: false,
    children: [],
  };
  const expression = convertCodexNode({
    ...neutral,
    type: "group",
    conjunction: "and",
    field: "",
    operator: "none",
    children: [
      { ...neutral, type: "clause", field: "category", operator: "eq", valueKind: "string", stringValues: ["Vestes"] },
      { ...neutral, type: "clause", field: "", operator: "none" },
    ],
  });
  assert.deepEqual(expression, {
    type: "group",
    conjunction: "and",
    children: [{ type: "clause", field: "category", operator: "eq", value: "Vestes" }],
  });
});

test("SQLite repository persists products, decisions, and arbitrary scores", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  assert.equal(repository.upsertProducts(seedProducts), seedProducts.length);
  assert.equal(repository.patchProducts(["seed_1"], { decision: "rejected", scores: { too_workwear: 82 } }), 1);
  const product = repository.getProduct("seed_1");
  assert.equal(product?.decision, "rejected");
  assert.equal(product?.scores.too_workwear, 82);
  assert.equal(repository.stats().products, seedProducts.length);
  db.close();
});

test("visual jobs stream only non-rejected scores strictly above their threshold", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  repository.upsertProducts(seedProducts);
  repository.createVisualJob({
    id: "vision_test",
    prompt: "brun ténébreux",
    maxInspections: 3,
    targetCount: 2,
    threshold: .5,
    analysisMode: "sequential",
    referenceImages: ["/tmp/mood-board.jpg"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "seed_1", score: .5, rejected: false,
    reason: "Borderline", signals: ["brown"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "seed_2", score: .51, rejected: false,
    reason: "Pass", signals: ["wide"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "seed_3", score: .9, rejected: true,
    reason: "Hard conflict", signals: [],
  });
  const job = repository.getVisualJob("vision_test");
  assert.equal(job?.inspected, 3);
  assert.equal(job?.selected, 1);
  assert.equal(job?.analysisMode, "sequential");
  assert.deepEqual(job?.referenceImages, ["/tmp/mood-board.jpg"]);
  assert.equal(repository.getProduct("seed_2")?.scores.visual_match, 51);
  assert.equal(repository.listVisualAssessments("vision_test")[0]?.productId, "seed_3");
  db.close();
});
