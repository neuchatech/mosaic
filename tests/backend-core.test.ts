import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../server/database";
import { CatalogRepository } from "../server/repository";
import { seedProducts } from "./fixtures/products";
import { filterSpecSchema, productSchema, type Product } from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";

const schema = readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8");

function repository(): { db: Database.Database; repository: CatalogRepository } {
  const db = new Database(":memory:");
  db.exec(schema);
  return { db, repository: new CatalogRepository(db) };
}

function product(id: string, overrides: Partial<Product> = {}): Product {
  return productSchema.parse({
    ...seedProducts[0],
    id,
    sourceId: id,
    url: `https://example.invalid/${id}`,
    importedAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  });
}

test("in/not_in use exact membership while contains remains substring matching", () => {
  const products = [
    product("exact", { sizes: ["M"] }),
    product("combined", { sizes: ["M/L"] }),
  ];
  const exact = filterSpecSchema.parse({
    id: "exact-size",
    name: "M exact",
    where: { type: "clause", field: "sizes", operator: "in", value: ["M"] },
  });
  const substring = filterSpecSchema.parse({
    id: "substring-size",
    name: "M substring",
    where: { type: "clause", field: "sizes", operator: "contains", value: "M" },
  });
  assert.deepEqual(applyFilter(products, exact).map(({ id }) => id), ["exact"]);
  assert.deepEqual(applyFilter(products, substring).map(({ id }) => id), ["exact", "combined"]);
});

test("repository filters the complete corpus before applying the result limit", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  const products = Array.from({ length: 8 }, (_, index) => product(`product-${index}`, {
    decision: index === 7 ? "saved" : "unseen",
    updatedAt: `2026-08-${String(28 - index).padStart(2, "0")}T10:00:00.000Z`,
  }));
  context.repository.upsertProducts(products);
  const filter = filterSpecSchema.parse({
    id: "saved",
    name: "Saved",
    where: { type: "clause", field: "decision", operator: "eq", value: "saved" },
    limit: 1,
  });
  assert.deepEqual(
    context.repository.listProducts({ filter, limit: 1 }).map(({ id }) => id),
    ["product-7"],
  );
});

test("collector upserts refresh shop facts but preserve every user-owned field", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  context.repository.upsertProducts([product("coat", {
    price: 100,
    tags: ["collector-tag"],
    x: 0.1,
    y: 0.2,
  })]);
  context.repository.patchProducts(["coat"], {
    decision: "saved",
    tags: ["user-tag"],
    annotations: { note: "great with wide trousers" },
    scores: { wardrobe_fit: 93 },
  });
  context.repository.replaceCoordinates([{ ...context.repository.getProduct("coat")!, x: 0.77, y: 0.66 }]);
  context.repository.upsertCollectedProducts([product("coat", {
    price: 79,
    sizes: ["M", "L"],
    stockStatus: "in_stock",
    stockCheckedAt: "2026-08-28T10:00:00.000Z",
    priceCheckedAt: "2026-08-28T10:00:00.000Z",
    sizesCheckedAt: "2026-08-28T10:00:00.000Z",
    decision: "unseen",
    tags: ["fresh-tag"],
    annotations: {},
    scores: {},
    x: 0.5,
    y: 0.5,
  })]);
  const updated = context.repository.getProduct("coat")!;
  assert.equal(updated.price, 79);
  assert.deepEqual(updated.sizes, ["M", "L"]);
  assert.equal(updated.stockStatus, "in_stock");
  assert.equal(updated.decision, "saved");
  assert.equal(updated.scores.wardrobe_fit, 93);
  assert.equal(updated.annotations?.note, "great with wide trousers");
  assert.deepEqual(updated.tags.sort(), ["collector-tag", "fresh-tag", "user-tag"]);
  assert.equal(updated.x, 0.77);
  assert.equal(updated.y, 0.66);
});

test("decision changes are journaled and undone atomically", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  context.repository.upsertProducts([
    product("one", { decision: "unseen" }),
    product("two", { decision: "owned" }),
  ]);
  const action = context.repository.setDecision(["one", "two"], "rejected");
  assert.ok(action.actionId);
  assert.deepEqual(action.products.map(({ decision }) => decision), ["rejected", "rejected"]);
  const undone = context.repository.undoDecision(action.actionId);
  assert.deepEqual(undone?.products.map(({ decision }) => decision), ["unseen", "owned"]);
  assert.equal(context.repository.undoDecision(action.actionId), null);
});

test("coordinate replacement leaves freshness and updatedAt untouched", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  const initial = product("stable", {
    updatedAt: "2026-08-21T12:00:00.000Z",
    stockCheckedAt: "2026-08-22T12:00:00.000Z",
  });
  context.repository.upsertProducts([initial]);
  context.repository.replaceCoordinates([{ ...initial, x: 0.8, y: 0.9 }]);
  const updated = context.repository.getProduct("stable")!;
  assert.equal(updated.updatedAt, initial.updatedAt);
  assert.equal(updated.stockCheckedAt, initial.stockCheckedAt);
  assert.equal(updated.x, 0.8);
});

test("legacy SQLite migrations are idempotent and configure a busy timeout", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'shop', source TEXT NOT NULL,
      source_id TEXT NOT NULL, url TEXT NOT NULL, brand TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', price REAL, original_price REAL,
      currency TEXT NOT NULL DEFAULT 'CHF', category TEXT NOT NULL DEFAULT 'Autre',
      color TEXT NOT NULL DEFAULT 'Inconnue', color_family TEXT NOT NULL DEFAULT 'unknown',
      fit TEXT NOT NULL DEFAULT 'unknown', attributes_json TEXT NOT NULL DEFAULT '{}',
      materials_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]',
      sizes_json TEXT NOT NULL DEFAULT '[]', images_json TEXT NOT NULL DEFAULT '[]',
      available INTEGER NOT NULL DEFAULT 1, decision TEXT NOT NULL DEFAULT 'unseen',
      x REAL NOT NULL DEFAULT .5, y REAL NOT NULL DEFAULT .5,
      scores_json TEXT NOT NULL DEFAULT '{}', imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(source, source_id)
    );
    CREATE TABLE visual_jobs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', max_inspections INTEGER NOT NULL,
      target_count INTEGER NOT NULL, threshold REAL NOT NULL DEFAULT 0.5,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  migrateDatabase(db);
  migrateDatabase(db);
  const productColumns = new Set((db.pragma("table_info(products)") as { name: string }[]).map(({ name }) => name));
  const visionColumns = new Set((db.pragma("table_info(visual_jobs)") as { name: string }[]).map(({ name }) => name));
  assert.ok(productColumns.has("stock_status"));
  assert.ok(productColumns.has("annotations_json"));
  assert.ok(visionColumns.has("constraints_json"));
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
});

test("saved views and outfit boards support persistent CRUD", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  context.repository.upsertProducts([product("jacket"), product("trousers")]);
  const filter = filterSpecSchema.parse({
    id: "brown",
    name: "Brown",
    where: { type: "clause", field: "colorFamily", operator: "eq", value: "brown" },
  });
  context.repository.saveView({
    id: "view-1",
    name: "Brown board",
    filter,
    state: { mode: "space", zoom: 1.2 },
  });
  assert.equal(context.repository.getView("view-1")?.state.zoom, 1.2);
  assert.equal(context.repository.listViews().length, 1);
  assert.equal(context.repository.deleteView("view-1"), true);

  context.repository.saveOutfitBoard({
    id: "outfit-1",
    name: "Autumn",
    metadata: { novelty: 0.8 },
    items: [
      { productId: "jacket", role: "outerwear" },
      { productId: "trousers", role: "bottom" },
    ],
  });
  assert.deepEqual(
    context.repository.getOutfitBoard("outfit-1")?.items.map(({ role }) => role),
    ["outerwear", "bottom"],
  );
  assert.equal(context.repository.deleteOutfitBoard("outfit-1"), true);
});

test("visual job constraints and candidate membership are frozen", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  context.repository.upsertProducts([product("candidate"), product("outsider")]);
  const job = context.repository.createVisualJob({
    id: "vision-frozen",
    prompt: "brown cropped jacket",
    maxInspections: 4,
    targetCount: 2,
    threshold: 0.5,
    analysisMode: "sequential",
    referenceImages: [],
    constraints: { sizes: ["M"], maxPrice: 150 },
    candidateIds: ["candidate"],
  });
  assert.deepEqual(job.constraints, { sizes: ["M"], maxPrice: 150 });
  assert.equal(job.candidateCount, 1);
  assert.equal(context.repository.isVisualJobCandidate(job.id, "candidate"), true);
  assert.deepEqual(context.repository.listVisualJobCandidateIds(job.id), ["candidate"]);
  assert.throws(() => context.repository.freezeVisualJobCandidates(job.id, ["outsider"]));
  assert.throws(() => context.repository.recordVisualAssessment({
    jobId: job.id,
    productId: "outsider",
    score: 0.9,
    rejected: false,
    reason: "not frozen",
    signals: [],
  }));
});

test("acquisition jobs persist resumable item progress", (t) => {
  const context = repository();
  t.after(() => context.db.close());
  const job = context.repository.createAcquisitionJob({
    id: "refresh-visible",
    source: "zalando",
    items: [
      { id: "item-z", url: "https://example.invalid/a" },
      { id: "item-a", url: "https://example.invalid/b" },
    ],
  });
  assert.equal(job.totalItems, 2);
  const first = context.repository.claimNextAcquisitionItem(job.id)!;
  assert.equal(first.id, "item-z");
  assert.equal(context.repository.recordAcquisitionItemAttempt(job.id, first.id).attempts, 1);
  assert.equal(context.repository.recordAcquisitionItemAttempt(job.id, first.id).attempts, 2);
  context.repository.completeAcquisitionItem(job.id, first.id, { payload: { price: 99 } });
  const second = context.repository.claimNextAcquisitionItem(job.id)!;
  const blocked = context.repository.blockAcquisitionItem(job.id, second.id, "captcha");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.progress, 1);
  assert.equal(context.repository.retryAcquisitionItems(job.id, [second.id]), 1);
  assert.equal(context.repository.listAcquisitionItems(job.id)[1]?.status, "queued");
});
