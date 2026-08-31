import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../server/database";
import { CatalogRepository } from "../server/repository";
import { productSchema, type Product } from "../src/domain/catalog";
import {
  DEFAULT_CLOTHING_WORKSPACE_ID,
  runViewSchema,
} from "../src/domain/workspace";

const timestamp = "2026-08-29T10:00:00.000Z";

function createRepository(): { db: Database.Database; repository: CatalogRepository } {
  const db = new Database(":memory:");
  migrateDatabase(db);
  return { db, repository: new CatalogRepository(db) };
}

function product(id: string, overrides: Partial<Product> = {}): Product {
  return productSchema.parse({
    id,
    source: "v1-test",
    sourceId: id,
    url: `https://example.invalid/${id}`,
    brand: "Test maker",
    name: `Item ${id}`,
    description: "Fixture item",
    price: 100,
    originalPrice: null,
    currency: "CHF",
    category: "Generic",
    color: "Black",
    colorFamily: "black",
    fit: "regular",
    attributes: {},
    materials: [],
    tags: [],
    sizes: [],
    images: [`https://images.example.invalid/${id}.jpg`],
    available: true,
    decision: "unseen",
    x: 0.5,
    y: 0.5,
    scores: {},
    importedAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

test("V1 migration is idempotent and preserves legacy catalog identity and behavior", (t) => {
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
    CREATE TABLE outfit_boards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE outfit_board_items (
      board_id TEXT NOT NULL, product_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'item',
      position INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      PRIMARY KEY(board_id, product_id)
    );
    INSERT INTO products (
      id, kind, source, source_id, url, brand, name, description, price,
      original_price, currency, category, color, color_family, fit,
      attributes_json, materials_json, tags_json, sizes_json, images_json,
      available, decision, x, y, scores_json, imported_at, updated_at
    ) VALUES (
      'legacy-product', 'shop', 'legacy', 'source-42', 'https://example.invalid/legacy',
      'Archive', 'Legacy item', 'Must survive', 89, 129, 'CHF', 'Vestes',
      'Brown', 'brown', 'cropped', '{"season":"autumn"}', '["wool"]',
      '["kept"]', '["M","L"]', '["https://images.example.invalid/legacy.jpg"]',
      1, 'saved', .17, .83, '{"style_match":91}',
      '${timestamp}', '${timestamp}'
    );
    INSERT INTO outfit_boards (
      id, name, description, metadata_json, created_at, updated_at
    ) VALUES ('legacy-board', 'Autumn set', 'Existing board', '{"legacy":true}', '${timestamp}', '${timestamp}');
    INSERT INTO outfit_board_items (
      board_id, product_id, role, position, notes, created_at
    ) VALUES ('legacy-board', 'legacy-product', 'outerwear', 0, 'keep role', '${timestamp}');
  `);

  migrateDatabase(db);
  const first = new CatalogRepository(db);
  migrateDatabase(db);
  const repository = new CatalogRepository(db);

  assert.equal(first.listProducts().length, 1);
  assert.equal(repository.listProducts().length, 1);
  assert.equal(repository.getWorkspace(DEFAULT_CLOTHING_WORKSPACE_ID)?.profile, "clothing");
  const migrated = repository.getProduct("legacy-product")!;
  assert.equal(migrated.id, "legacy-product");
  assert.equal(migrated.sourceId, "source-42");
  assert.equal(migrated.workspaceId, DEFAULT_CLOTHING_WORKSPACE_ID);
  assert.equal(migrated.decision, "saved");
  assert.deepEqual(migrated.sizes, ["M", "L"]);
  assert.deepEqual(migrated.images, ["https://images.example.invalid/legacy.jpg"]);
  assert.deepEqual(migrated.attributes, { season: "autumn" });
  assert.equal(migrated.scores.style_match, 91);
  assert.equal(migrated.x, 0.17);
  assert.equal(migrated.y, 0.83);

  const favorites = repository.listCollections(DEFAULT_CLOTHING_WORKSPACE_ID)
    .find(({ systemKey }) => systemKey === "favorites")!;
  assert.deepEqual(favorites.items.map(({ itemId }) => itemId), ["legacy-product"]);
  const migratedBoard = repository.getCollection("legacy-outfit:legacy-board")!;
  assert.equal(migratedBoard.name, "Autumn set");
  assert.deepEqual(migratedBoard.items.map(({ itemId, role }) => ({ itemId, role })), [
    { itemId: "legacy-product", role: "outerwear" },
  ]);
});

test("workspaces isolate catalog items and collection membership", (t) => {
  const context = createRepository();
  t.after(() => context.db.close());
  context.repository.createWorkspace({ id: "televisions", name: "Televisions", profile: "televisions" });
  context.repository.upsertProducts([
    product("coat", { workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID, category: "Vestes" }),
    product("tv", { workspaceId: "televisions", category: "OLED television" }),
  ]);

  assert.deepEqual(
    context.repository.listProducts({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID }).map(({ id }) => id),
    ["coat"],
  );
  assert.deepEqual(
    context.repository.listProducts({ workspaceId: "televisions" }).map(({ id }) => id),
    ["tv"],
  );
  assert.equal(context.repository.getProduct("coat", "televisions"), null);

  const collection = context.repository.createCollection({
    id: "tv-shortlist",
    workspaceId: "televisions",
    type: "manual",
    name: "Shortlist",
    color: "#123456",
    description: "Keep this metadata",
  });
  const renamed = context.repository.updateCollection(collection.id, { name: "TV shortlist" })!;
  assert.equal(renamed.color, "#123456");
  assert.equal(renamed.description, "Keep this metadata");
  context.repository.updateWorkspace("televisions", { settings: { locale: "fr-CH" } });
  const renamedWorkspace = context.repository.updateWorkspace("televisions", { name: "Displays" })!;
  assert.deepEqual(renamedWorkspace.settings, { locale: "fr-CH" });
  assert.throws(
    () => context.repository.addCollectionItems(collection.id, [{ itemId: "coat" }]),
    /cross-workspace/,
  );
  assert.throws(() => context.repository.deleteWorkspace("televisions"), /still contains/);
});

test("collections preserve explicit order while Favorites follows saved decisions", (t) => {
  const context = createRepository();
  t.after(() => context.db.close());
  context.repository.upsertProducts([
    product("first"),
    product("second"),
    product("third"),
  ]);
  const collection = context.repository.createCollection({
    id: "ordered",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    type: "manual",
    name: "Ordered board",
  });
  const ordered = context.repository.replaceCollectionItems(collection.id, [
    { itemId: "first", position: 20, role: "anchor" },
    { itemId: "second", position: 0 },
    { itemId: "third", position: 10 },
  ]);
  assert.deepEqual(ordered.items.map(({ itemId, position }) => ({ itemId, position })), [
    { itemId: "second", position: 0 },
    { itemId: "third", position: 1 },
    { itemId: "first", position: 2 },
  ]);
  assert.equal(ordered.items.at(-1)?.role, "anchor");
  assert.deepEqual(
    context.repository.removeCollectionItems(collection.id, ["third"]).items.map(({ itemId }) => itemId),
    ["second", "first"],
  );

  const action = context.repository.setDecision(["first"], "saved");
  const favorites = context.repository.listCollections(DEFAULT_CLOTHING_WORKSPACE_ID)
    .find(({ systemKey }) => systemKey === "favorites")!;
  assert.deepEqual(favorites.items.map(({ itemId }) => itemId), ["first"]);
  assert.throws(
    () => context.repository.addCollectionItems(favorites.id, [{ itemId: "second" }]),
    /synchronized/,
  );
  context.repository.undoDecision(action.actionId);
  assert.deepEqual(context.repository.getCollection(favorites.id)?.items, []);
  assert.equal(context.repository.getProduct("first")?.decision, "unseen");
});

test("dynamic schema inference is conservative, workspace-aware, and explicitly committed", (t) => {
  const context = createRepository();
  t.after(() => context.db.close());
  context.repository.createWorkspace({ id: "televisions", name: "Televisions", profile: "televisions" });
  const panelTypes = ["OLED", "OLED", "Mini LED", "Mini LED"];
  context.repository.upsertProducts(Array.from({ length: 4 }, (_, index) => product(`tv-${index}`, {
    workspaceId: "televisions",
    brand: `Maker ${index}`,
    category: "Television",
    attributes: {
      screenSize: [55, 65, 55, 77][index]!,
      refreshRate: [120, 144, 120, 60][index]!,
      panelType: panelTypes[index]!,
      marketingBlurb: `Unique prose ${index}`,
      ...(index < 2 ? { sparseField: `sparse-${index}` } : {}),
    },
  })));

  const before = context.repository.getWorkspace("televisions")!;
  const inferred = context.repository.inferWorkspaceSchema("televisions");
  assert.equal(context.repository.listFieldDefinitions("televisions").length, 0);
  assert.equal(context.repository.getWorkspace("televisions")?.schemaVersion, before.schemaVersion);
  assert.ok(!inferred.some(({ key }) => key === "sizes" || key === "fit"));
  assert.ok(!inferred.some(({ key }) => key === "attributes.sparseField"));
  assert.equal(inferred.find(({ key }) => key === "attributes.screenSize")?.primitiveType, "number");
  assert.equal(inferred.find(({ key }) => key === "attributes.screenSize")?.facetable, true);
  assert.equal(inferred.find(({ key }) => key === "attributes.panelType")?.primitiveType, "enum");
  assert.equal(inferred.find(({ key }) => key === "attributes.panelType")?.facetable, true);
  assert.equal(inferred.find(({ key }) => key === "attributes.marketingBlurb")?.primitiveType, "text");
  assert.equal(inferred.find(({ key }) => key === "attributes.marketingBlurb")?.facetable, false);

  context.repository.commitWorkspaceSchema("televisions", inferred, { replace: true });
  const schema = context.repository.getWorkspaceSchema("televisions");
  assert.equal(schema.workspace.schemaVersion, before.schemaVersion + 1);
  assert.ok(schema.fields.every(({ schemaVersion }) => schemaVersion === schema.workspace.schemaVersion));
  const sizeFacet = schema.facets.find(({ fieldKey }) => fieldKey === "attributes.screenSize")!;
  assert.equal(sizeFacet.observed, 4);
  assert.equal(sizeFacet.cardinality, 3);
  assert.equal(sizeFacet.min, 55);
  assert.equal(sizeFacet.max, 77);
  assert.deepEqual(sizeFacet.values.find(({ value }) => value === 55), { value: 55, count: 2 });
});

test("artifacts persist provenance and reject cross-workspace inputs", (t) => {
  const context = createRepository();
  t.after(() => context.db.close());
  context.repository.createWorkspace({ id: "televisions", name: "Televisions", profile: "televisions" });
  context.repository.upsertProducts([
    product("coat"),
    product("tv", { workspaceId: "televisions" }),
  ]);
  const shortlist = context.repository.createCollection({
    id: "tv-artifact-input",
    workspaceId: "televisions",
    type: "manual",
    name: "Compare",
  });
  context.repository.addCollectionItems(shortlist.id, [{ itemId: "tv" }]);
  const artifact = context.repository.createArtifact({
    id: "comparison-report",
    workspaceId: "televisions",
    type: "comparison",
    name: "OLED comparison",
    prompt: "Compare the selected displays",
    inputItemIds: ["tv"],
    inputCollectionIds: [shortlist.id],
    generator: "codex",
    provenance: { model: "local", revision: 1 },
  });
  assert.equal(artifact.status, "draft");
  const finished = context.repository.updateArtifact(artifact.id, {
    status: "succeeded",
    localFiles: ["/tmp/oled-comparison.html"],
  })!;
  assert.ok(finished.finishedAt);
  assert.deepEqual(finished.provenance, { model: "local", revision: 1 });
  assert.deepEqual(new CatalogRepository(context.db).getArtifact(artifact.id)?.localFiles, [
    "/tmp/oled-comparison.html",
  ]);
  assert.throws(() => context.repository.createArtifact({
    workspaceId: "televisions",
    type: "report",
    name: "Invalid mixed report",
    inputItemIds: ["coat"],
  }), /items: coat/);
});

test("normalized activity and visual job listing expose stable V1 views", (t) => {
  const context = createRepository();
  t.after(() => context.db.close());
  context.repository.createVisualJob({
    id: "visual-run",
    prompt: "Find the strongest match",
    maxInspections: 5,
    targetCount: 2,
    threshold: 0.5,
    analysisMode: "sheet",
    referenceImages: [],
  });
  assert.deepEqual(context.repository.listVisualJobs().map(({ id }) => id), ["visual-run"]);
  const run = runViewSchema.parse({
    id: "visual-run",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    kind: "visual-scoring",
    title: "Find the strongest match",
    status: "running",
    progress: 0.4,
    total: 5,
    completed: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  assert.equal(run.canResume, false);
  assert.equal(run.failed, 0);
});
