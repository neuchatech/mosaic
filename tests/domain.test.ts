import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CatalogRepository } from "../server/repository";
import { convertCodexNode, normalizeCodexFilterForCatalog, relaxSoftFilterForCatalog } from "../server/codex-bridge";
import { getVisualSelection } from "../server/visual-selection";
import { seedProducts } from "./fixtures/products";
import { filterSpecSchema } from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";
import { compactProjection } from "../src/projection/compact";
import { projectProducts, projectProductsWithVectors } from "../src/projection/pca";
import { normalizeZalandoSizes } from "../collector/adapters/zalando";
import { guessCategory, guessColorFamily, guessFit, guessTags } from "../collector/normalize";

test("nested filters can inspect standard, dynamic, and negated criteria", () => {
  const filter = filterSpecSchema.parse({
    id: "test",
    name: "complex",
    where: {
      type: "group",
      conjunction: "and",
      children: [
        { type: "clause", field: "colorFamily", operator: "in", value: ["blue", "grey", "beige"] },
        { type: "not", child: { type: "clause", field: "tags", operator: "contains", value: "sportswear" } },
        { type: "clause", field: "scores.style_match", operator: "gte", value: 85 },
        { type: "clause", field: "attributes.fixture", operator: "eq", value: true }
      ]
    },
    limit: 100
  });
  const result = applyFilter(seedProducts, filter);
  assert.deepEqual(result.map((product) => product.id), ["fixture-1", "fixture-2", "fixture-3"]);
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

test("date range filters compare ISO freshness timestamps", () => {
  const products = seedProducts.slice(0, 2).map((product, index) => ({
    ...product,
    sizesCheckedAt: index === 0 ? "2026-08-29T12:00:00.000Z" : "2026-08-20T12:00:00.000Z",
  }));
  const filter = filterSpecSchema.parse({
    id: "fresh-sizes",
    name: "Fresh size snapshot",
    where: { type: "clause", field: "sizesCheckedAt", operator: "gte", value: "2026-08-28T12:00:00.000Z" },
  });
  assert.deepEqual(applyFilter(products, filter).map((product) => product.id), [products[0]!.id]);
});

test("Zalando size capture keeps only available-looking garment sizes", () => {
  assert.deepEqual(
    normalizeZalandoSizes(["Taille: M", "XL disponible", "Choisir une taille", "48", "M", "EU 50"]),
    ["M", "XL", "48", "EU 50"],
  );
});

test("catalog normalization separates footwear and accessories", () => {
  assert.equal(guessCategory("Leather loafer - dark brown"), "Chaussures");
  assert.equal(guessCategory("Ceinture tressée en cuir"), "Accessoires");
  assert.equal(guessCategory("Crossbody bag - olive"), "Accessoires");
  assert.equal(guessCategory("Pantalon wide leg"), "Pantalons");
  assert.equal(guessCategory("TAILORED BAGGY - Stoffhose - dark grey"), "Pantalons");
  assert.equal(guessCategory("BOOTCUT - Jeans - indigo"), "Pantalons");
  assert.equal(guessCategory("BELTED WIDE LEG TROUSERS - brown"), "Pantalons");
  assert.equal(guessCategory("BASKETBALL SHORTS - navy"), "Pantalons");
  assert.equal(guessCategory("SHORT SLEEVE SHIRT - white"), "Chemises");
  assert.equal(guessCategory("LOCKERE STOFFHOSE - braun"), "Pantalons");
  assert.equal(guessCategory("STRICKJACKE - beige"), "Mailles");
  assert.equal(guessCategory("PLEATED TWILL - Anzughose - navy"), "Pantalons");
  assert.equal(guessCategory("MASSUM - Gilet - dk brown mix"), "Mailles");
  assert.equal(guessCategory("CITY RETRO - Baskets basses - sage"), "Chaussures");
  assert.equal(guessCategory("Langarmshirt - off white"), "T-shirts");
  assert.equal(guessColorFamily("Cardigan chocolate brown"), "brown");
  assert.equal(guessColorFamily("Sneaker navy blue"), "blue");
  assert.equal(guessColorFamily("Collier gold-coloured"), "beige");
  assert.equal(guessFit("Loose pleated trousers"), "wide");
  assert.deepEqual(guessTags("Vintage washed chore jacket"), ["washed", "utility"]);
  assert.deepEqual(guessTags("Bonnet noir"), ["headwear"]);
  assert.deepEqual(guessTags("Collier silver-coloured"), ["jewelry"]);
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

test("hybrid PCA accepts visual rows and metadata-only fallbacks without erasing block weights", () => {
  const products = seedProducts.slice(0, 3);
  const vectors = new Map([
    [products[0]!.id, [1, 0, .2, .4]],
    [products[1]!.id, [0, 1, .3, .1]],
  ]);
  const projected = projectProductsWithVectors(products, { vectorsById: vectors, scale: false });
  assert.equal(projected.length, 3);
  assert.ok(projected.every((product) => Number.isFinite(product.x) && Number.isFinite(product.y)));
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

test("semantic catalog filters repair invented text fields and preserve at-least-two logic", () => {
  const products = [
    { ...seedProducts[0]!, id: "ribbed-knit", sourceId: "ribbed-knit", name: "Ribbed knit jumper", category: "Mailles", fit: "straight" },
    { ...seedProducts[1]!, id: "baggy-cord", sourceId: "baggy-cord", name: "Baggy corduroy trousers", category: "Pantalons", fit: "large" },
    { ...seedProducts[2]!, id: "plain-baggy", sourceId: "plain-baggy", name: "Baggy cotton trousers", category: "Pantalons", fit: "large" },
    { ...seedProducts[0]!, id: "plain-shirt", sourceId: "plain-shirt", name: "Poplin shirt", category: "Chemises", fit: "straight" },
  ];
  const generated = filterSpecSchema.parse({
    id: "semantic-two-of-three",
    name: "Textured, knit or baggy",
    where: {
      type: "group",
      conjunction: "or",
      children: [
        { type: "group", conjunction: "and", children: [
          { type: "clause", field: "attributes.listingText", operator: "contains", value: "texturé" },
          { type: "clause", field: "category", operator: "eq", value: "Mailles" },
        ] },
        { type: "group", conjunction: "and", children: [
          { type: "clause", field: "attributes.listingText", operator: "contains", value: "texturé" },
          { type: "clause", field: "fit", operator: "eq", value: "baggy" },
        ] },
        { type: "group", conjunction: "and", children: [
          { type: "clause", field: "category", operator: "eq", value: "Mailles" },
          { type: "clause", field: "fit", operator: "eq", value: "baggy" },
        ] },
      ],
    },
    limit: 100,
  });
  const repaired = { ...generated, where: normalizeCodexFilterForCatalog(generated.where, products) };
  assert.deepEqual(applyFilter(products, repaired).map((product) => product.id), ["ribbed-knit", "baggy-cord"]);
});

test("soft preferences relax before a valid semantic search becomes an empty board", () => {
  const products = [
    { ...seedProducts[0]!, id: "leather-jacket", sourceId: "leather-jacket", name: "Leather jacket", category: "Vestes", fit: "unknown", materials: ["leather"] },
    { ...seedProducts[1]!, id: "cotton-jacket", sourceId: "cotton-jacket", name: "Cotton jacket", category: "Vestes", fit: "courte", materials: ["cotton"] },
  ];
  const exact = filterSpecSchema.parse({
    id: "soft-cut",
    name: "Leather jackets, preferably short",
    where: { type: "group", conjunction: "and", children: [
      { type: "clause", field: "category", operator: "eq", value: "Vestes" },
      { type: "clause", field: "materials", operator: "in", value: ["leather"] },
      { type: "clause", field: "fit", operator: "eq", value: "courte" },
    ] },
    limit: 100,
  });
  assert.equal(applyFilter(products, exact).length, 0);
  const relaxed = relaxSoftFilterForCatalog(exact, "vestes en cuir, plutôt courtes", products);
  assert.deepEqual(applyFilter(products, relaxed).map((product) => product.id), ["leather-jacket"]);
});

test("SQLite repository persists products, decisions, and arbitrary scores", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  assert.equal(repository.upsertProducts(seedProducts), seedProducts.length);
  assert.equal(repository.patchProducts(["fixture-1"], { decision: "rejected", scores: { too_workwear: 82 } }), 1);
  const product = repository.getProduct("fixture-1");
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
    prompt: "visual fixture",
    maxInspections: 3,
    targetCount: 2,
    threshold: .5,
    analysisMode: "sequential",
    referenceImages: ["/tmp/mood-board.jpg"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "fixture-1", score: .5, rejected: false,
    reason: "Borderline", signals: ["brown"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "fixture-2", score: .51, rejected: false,
    reason: "Pass", signals: ["wide"],
  });
  repository.recordVisualAssessment({
    jobId: "vision_test", productId: "fixture-3", score: .9, rejected: true,
    reason: "Hard conflict", signals: [],
  });
  const job = repository.getVisualJob("vision_test");
  assert.equal(job?.inspected, 3);
  assert.equal(job?.selected, 1);
  assert.equal(job?.analysisMode, "sequential");
  assert.deepEqual(job?.referenceImages, ["/tmp/mood-board.jpg"]);
  assert.equal(repository.getProduct("fixture-2")?.scores.visual_match, undefined);
  assert.equal(repository.listVisualAssessments("vision_test")[0]?.productId, "fixture-3");
  const view = getVisualSelection("vision_test", repository);
  assert.deepEqual(view?.products.map((product) => product.id), ["fixture-2"]);
  assert.equal(view?.products[0]?.scores.visual_match, 51);
  assert.equal(view?.products[0]?.attributes.visual_reason, "Pass");
  db.close();
});
