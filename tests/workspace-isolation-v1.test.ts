import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { normalizeProduct } from "../collector/normalize";
import { AcquisitionService } from "../server/acquisition";
import { createApp } from "../server/app";
import { migrateDatabase } from "../server/database";
import { DiscoveryService, validateDiscoveryIntent } from "../server/discovery";
import { CatalogRepository } from "../server/repository";
import { filterSpecSchema } from "../src/domain/catalog";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

const OTHER_WORKSPACE_ID = "televisions";

function createRepository(): { db: Database.Database; repository: CatalogRepository } {
  const db = new Database(":memory:");
  migrateDatabase(db);
  const repository = new CatalogRepository(db);
  repository.createWorkspace({ id: OTHER_WORKSPACE_ID, name: "Televisions", profile: "televisions" });
  return { db, repository };
}

function addSharedShopProduct(repository: CatalogRepository) {
  const raw = {
    sourceId: "shared-retailer-id",
    url: "https://www.zalando.ch/example-shared-product.html",
    brand: "Shared",
    name: "Shared public product",
    price: 99,
    currency: "CHF",
    category: "Vestes",
    images: ["https://img01.ztat.net/article/example.jpg"],
  };
  const clothing = normalizeProduct("zalando-ch", raw, DEFAULT_CLOTHING_WORKSPACE_ID);
  const television = normalizeProduct("zalando-ch", raw, OTHER_WORKSPACE_ID);
  repository.upsertCollectedProducts([clothing, television]);
  return { clothing, television };
}

test("the same public product has independent identity and decisions in two workspaces", (t) => {
  const { db, repository } = createRepository();
  t.after(() => db.close());
  const { clothing, television } = addSharedShopProduct(repository);

  assert.notEqual(clothing.id, television.id);
  assert.equal(repository.getProductBySource(
    DEFAULT_CLOTHING_WORKSPACE_ID,
    clothing.source,
    clothing.sourceId,
  )?.id, clothing.id);
  assert.equal(repository.getProductBySource(
    OTHER_WORKSPACE_ID,
    television.source,
    television.sourceId,
  )?.id, television.id);
  assert.equal(repository.listProducts({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID }).length, 1);
  assert.equal(repository.listProducts({ workspaceId: OTHER_WORKSPACE_ID }).length, 1);

  const action = repository.setDecision([television.id], "saved", OTHER_WORKSPACE_ID);
  assert.equal(repository.getProduct(television.id, OTHER_WORKSPACE_ID)?.decision, "saved");
  assert.equal(repository.getProduct(clothing.id, DEFAULT_CLOTHING_WORKSPACE_ID)?.decision, "unseen");
  assert.deepEqual(repository.listDecisionActions(20, OTHER_WORKSPACE_ID).map(({ id }) => id), [action.actionId]);
  assert.deepEqual(repository.listDecisionActions(20, DEFAULT_CLOTHING_WORKSPACE_ID), []);
  assert.throws(
    () => repository.setDecision([clothing.id, television.id], "rejected"),
    /multiple workspaces/,
  );

  const validated = validateDiscoveryIntent({
    source: "zalando-ch",
    workspaceId: ` ${OTHER_WORKSPACE_ID} `,
    query: "oled television",
    maxItems: 12,
  });
  assert.equal(validated.workspaceId, OTHER_WORKSPACE_ID);
});

test("outfits, visual jobs, acquisition jobs and run views remain workspace-isolated", async (t) => {
  const { db, repository } = createRepository();
  t.after(() => db.close());
  const { clothing, television } = addSharedShopProduct(repository);

  repository.saveOutfitBoard({
    id: "outfit-clothing",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    name: "Clothing board",
    items: [{ productId: clothing.id }],
  });
  repository.saveOutfitBoard({
    id: "outfit-tv",
    workspaceId: OTHER_WORKSPACE_ID,
    name: "TV board",
    items: [{ productId: television.id }],
  });
  assert.deepEqual(repository.listOutfitBoards(DEFAULT_CLOTHING_WORKSPACE_ID).map(({ id }) => id), ["outfit-clothing"]);
  assert.deepEqual(repository.listOutfitBoards(OTHER_WORKSPACE_ID).map(({ id }) => id), ["outfit-tv"]);
  assert.equal(repository.getOutfitBoard("outfit-tv", DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.throws(() => repository.saveOutfitBoard({
    id: "mixed-outfit",
    name: "Invalid",
    items: [{ productId: clothing.id }, { productId: television.id }],
  }), /multiple workspaces/);

  repository.createVisualJob({
    id: "visual-clothing",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    prompt: "clothing",
    maxInspections: 10,
    targetCount: 2,
    threshold: 0.5,
    analysisMode: "sequential",
    referenceImages: [],
    candidateIds: [clothing.id],
  });
  repository.createVisualJob({
    id: "visual-tv",
    workspaceId: OTHER_WORKSPACE_ID,
    prompt: "television",
    maxInspections: 10,
    targetCount: 2,
    threshold: 0.5,
    analysisMode: "sequential",
    referenceImages: [],
    candidateIds: [television.id],
  });
  assert.deepEqual(repository.listVisualJobs(20, DEFAULT_CLOTHING_WORKSPACE_ID).map(({ id }) => id), ["visual-clothing"]);
  assert.deepEqual(repository.listVisualJobs(20, OTHER_WORKSPACE_ID).map(({ id }) => id), ["visual-tv"]);
  assert.equal(repository.getVisualJob("visual-tv", DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.throws(() => repository.createVisualJob({
    id: "visual-cross-scope",
    workspaceId: OTHER_WORKSPACE_ID,
    prompt: "invalid",
    maxInspections: 10,
    targetCount: 2,
    threshold: 0.5,
    analysisMode: "sequential",
    referenceImages: [],
    candidateIds: [clothing.id],
  }), /cross-workspace/);
  assert.equal(repository.getVisualJob("visual-cross-scope"), null);

  repository.createAcquisitionJob({
    id: "acquisition-clothing",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    source: "test",
    items: [{ productId: clothing.id, url: clothing.url }],
  });
  repository.createAcquisitionJob({
    id: "acquisition-tv",
    workspaceId: OTHER_WORKSPACE_ID,
    source: "test",
    items: [{ productId: television.id, url: television.url }],
  });
  assert.deepEqual(
    repository.listAcquisitionJobs({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID }).map(({ id }) => id),
    ["acquisition-clothing"],
  );
  assert.deepEqual(
    repository.listAcquisitionJobs({ workspaceId: OTHER_WORKSPACE_ID }).map(({ id }) => id),
    ["acquisition-tv"],
  );
  assert.throws(() => repository.createAcquisitionJob({
    id: "acquisition-mixed",
    source: "test",
    items: [
      { productId: clothing.id, url: `${clothing.url}?one=1` },
      { productId: television.id, url: `${television.url}?two=1` },
    ],
  }), /multiple workspaces/);

  const acquisition = new AcquisitionService(repository, {
    fetcher: { fetch: async () => null },
    sameDomainDelayMs: 0,
  });
  const discovery = new DiscoveryService({
    fetcher: { fetch: async () => [] },
    sameDomainDelayMs: 0,
  });
  const app = createApp(repository, acquisition, discovery);

  const tvRunsResponse = await app.request(`http://local/api/runs?workspaceId=${OTHER_WORKSPACE_ID}`);
  assert.equal(tvRunsResponse.status, 200);
  const tvRuns = await tvRunsResponse.json() as { runs: Array<{ id: string; workspaceId: string }> };
  const tvRunIds = new Set(tvRuns.runs.map(({ id }) => id));
  assert.ok(tvRunIds.has("acquisition-tv"));
  assert.ok(tvRunIds.has("visual-tv"));
  assert.ok(!tvRunIds.has("acquisition-clothing"));
  assert.ok(!tvRunIds.has("visual-clothing"));
  assert.ok(tvRuns.runs.every(({ workspaceId }) => workspaceId === OTHER_WORKSPACE_ID));

  const clothingOutfitsResponse = await app.request(
    `http://local/api/outfit-boards?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`,
  );
  assert.equal(clothingOutfitsResponse.status, 200);
  const clothingOutfits = await clothingOutfitsResponse.json() as Array<{ id: string; workspaceId: string }>;
  assert.deepEqual(clothingOutfits.map(({ id }) => id), ["outfit-clothing"]);
  assert.ok(clothingOutfits.every(({ workspaceId }) => workspaceId === DEFAULT_CLOTHING_WORKSPACE_ID));

  const wrongVisualScope = await app.request(
    `http://local/api/codex/visual-jobs/visual-tv?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`,
  );
  assert.equal(wrongVisualScope.status, 404);

  const mixedDecision = await app.request("http://local/api/products/bulk-decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [clothing.id, television.id], decision: "saved" }),
  });
  assert.equal(mixedDecision.status, 409);

  const crossScopeAcquisition = await app.request("http://local/api/acquisition/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: OTHER_WORKSPACE_ID, productIds: [clothing.id, television.id] }),
  });
  assert.equal(crossScopeAcquisition.status, 400);
});

test("views, collections and artifacts reject cross-workspace UUID access", async (t) => {
  const { db, repository } = createRepository();
  t.after(() => db.close());
  const { clothing, television } = addSharedShopProduct(repository);
  const filter = filterSpecSchema.parse({
    id: "tv-filter",
    name: "TV filter",
    where: { type: "group", conjunction: "and", children: [] },
    limit: 100,
  });
  repository.saveView({
    id: "tv-view",
    workspaceId: OTHER_WORKSPACE_ID,
    name: "TV view",
    filter,
    state: { zoom: 1.2 },
  });
  const collection = repository.createCollection({
    id: "tv-collection",
    workspaceId: OTHER_WORKSPACE_ID,
    type: "manual",
    name: "TV collection",
  });
  repository.addCollectionItems(collection.id, [{ itemId: television.id }], OTHER_WORKSPACE_ID);
  repository.createArtifact({
    id: "tv-artifact",
    workspaceId: OTHER_WORKSPACE_ID,
    type: "comparison",
    name: "TV artifact",
    inputItemIds: [television.id],
    inputCollectionIds: [collection.id],
  });

  assert.equal(repository.getView("tv-view", DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.equal(repository.deleteView("tv-view", DEFAULT_CLOTHING_WORKSPACE_ID), false);
  assert.equal(repository.getCollection(collection.id, DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.equal(repository.updateCollection(collection.id, { name: "Wrong" }, DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.equal(repository.deleteCollection(collection.id, DEFAULT_CLOTHING_WORKSPACE_ID), false);
  assert.throws(
    () => repository.addCollectionItems(collection.id, [{ itemId: clothing.id }], DEFAULT_CLOTHING_WORKSPACE_ID),
    /Unknown collection/,
  );
  assert.equal(repository.getArtifact("tv-artifact", DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.equal(repository.updateArtifact("tv-artifact", { name: "Wrong" }, DEFAULT_CLOTHING_WORKSPACE_ID), null);
  assert.equal(repository.deleteArtifact("tv-artifact", DEFAULT_CLOTHING_WORKSPACE_ID), false);

  const acquisition = new AcquisitionService(repository, {
    fetcher: { fetch: async () => null },
    sameDomainDelayMs: 0,
  });
  const discovery = new DiscoveryService({
    fetcher: { fetch: async () => [] },
    sameDomainDelayMs: 0,
  });
  const app = createApp(repository, acquisition, discovery);

  for (const path of [
    "/api/views/tv-view",
    "/api/collections/tv-collection",
    "/api/artifacts/tv-artifact",
  ]) {
    assert.equal((await app.request(`http://local${path}`)).status, 404);
  }
  assert.equal((await app.request("http://local/api/views/tv-view?workspaceId=televisions")).status, 200);
  assert.equal((await app.request("http://local/api/collections/tv-collection?workspaceId=televisions")).status, 200);
  assert.equal((await app.request("http://local/api/artifacts/tv-artifact?workspaceId=televisions")).status, 200);

  const crossViewSave = await app.request("http://local/api/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "tv-view", name: "Wrong", filter }),
  });
  assert.equal(crossViewSave.status, 409);
  const crossCollectionPatch = await app.request("http://local/api/collections/tv-collection", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Wrong" }),
  });
  assert.equal(crossCollectionPatch.status, 404);
  const crossCollectionItems = await app.request("http://local/api/collections/tv-collection/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds: [clothing.id] }),
  });
  assert.equal(crossCollectionItems.status, 404);
  const crossArtifactPatch = await app.request("http://local/api/artifacts/tv-artifact", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Wrong" }),
  });
  assert.equal(crossArtifactPatch.status, 404);
  assert.equal(repository.getView("tv-view", OTHER_WORKSPACE_ID)?.name, "TV view");
  assert.equal(repository.getCollection("tv-collection", OTHER_WORKSPACE_ID)?.name, "TV collection");
  assert.equal(repository.getArtifact("tv-artifact", OTHER_WORKSPACE_ID)?.name, "TV artifact");
});
