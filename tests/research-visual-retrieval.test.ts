import assert from "node:assert/strict";
import test from "node:test";
import type { FilterSpec, Product } from "../src/domain/catalog";
import { productSchema } from "../src/domain/catalog";
import type { VisualEmbeddingRun } from "../src/embeddings";
import {
  rankWorkspaceByVisualReferences,
  type VisualRetrievalRepository,
} from "../server/visual-selection";

const timestamp = "2026-08-31T12:00:00.000Z";

function product(
  id: string,
  workspaceId: string,
  options: Partial<Product> = {},
): Product {
  return productSchema.parse({
    id,
    workspaceId,
    source: "fixture",
    sourceId: id,
    url: `https://example.test/${id}`,
    name: id,
    price: 100,
    currency: "CHF",
    category: "target",
    x: 0.5,
    y: 0.5,
    importedAt: timestamp,
    updatedAt: timestamp,
    ...options,
  });
}

function repositoryFor(products: Product[], workspaces = ["workspace-a", "workspace-b"]): VisualRetrievalRepository {
  return {
    getWorkspace(id) {
      return workspaces.includes(id) ? { id } as never : null;
    },
    getProduct(id, workspaceId) {
      return products.find((candidate) => candidate.id === id
        && (!workspaceId || candidate.workspaceId === workspaceId)) ?? null;
    },
    listProducts(options = {}) {
      return products
        .filter((candidate) => !options.workspaceId || candidate.workspaceId === options.workspaceId)
        .slice(0, options.limit);
    },
  };
}

function visualArtifact(
  visual: Record<string, number[] | null>,
  hybrid: Record<string, number[]> = {},
): VisualEmbeddingRun {
  const itemIds = [...new Set([...Object.keys(visual), ...Object.keys(hybrid)])];
  return {
    schemaVersion: 1,
    model: { id: "fixture/clip", revision: "local", dtype: "q8", expectedDimension: 2 },
    results: itemIds.map((itemId) => ({
      schemaVersion: 1,
      itemId,
      mode: visual[itemId] ? "hybrid" : "metadata-only",
      model: { id: "fixture/clip", revision: "local", dtype: "q8", expectedDimension: 2 },
      visualVector: visual[itemId] ?? null,
      metadataVector: [1, 0],
      hybridVector: hybrid[itemId] ?? visual[itemId] ?? [1, 0],
      imageUrls: [],
      contentHashes: [],
      cacheHit: true,
      processedAt: timestamp,
    })),
    summary: {
      total: itemIds.length,
      processed: itemIds.length,
      embedded: Object.values(visual).filter(Boolean).length,
      metadataOnly: Object.values(visual).filter((value) => !value).length,
      cacheHits: itemIds.length,
      imageDownloads: 0,
      errors: 0,
      cancelled: false,
      modelAvailable: true,
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  };
}

const targetFilter: FilterSpec = {
  id: "target-only",
  name: "Target only",
  description: "",
  where: { type: "clause", field: "category", operator: "eq", value: "target" },
  limit: 1,
};

test("app-owned image references rank an exact, filtered allowlist deterministically", async () => {
  const products = [
    product("same-first", "workspace-a"),
    product("same-second", "workspace-a"),
    product("orthogonal", "workspace-a"),
    product("filtered-out", "workspace-a", { category: "other" }),
    product("foreign", "workspace-b"),
  ];
  const artifact = visualArtifact({
    "same-first": [1, 0],
    "same-second": [1, 0],
    orthogonal: [0, 1],
    "filtered-out": [1, 0],
    foreign: [1, 0],
  });
  const result = await rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    referenceImagePaths: ["/api/media/research-ref/1.webp"],
    eligibleProductIds: ["same-second", "same-first", "orthogonal", "filtered-out"],
    filter: targetFilter,
    limit: 20,
  }, repositoryFor(products), {
    readEmbeddingArtifact: async () => artifact,
    embedReferenceImages: async (paths, model) => {
      assert.deepEqual(paths, ["/api/media/research-ref/1.webp"]);
      assert.equal(model.id, "fixture/clip");
      return { vectors: [[1, 0]], cacheHits: 1, modelAvailable: true, warnings: [] };
    },
  });

  // filter.limit is deliberately ignored: it must not turn a hard predicate
  // into an accidental pre-ranking top-one universe.
  assert.deepEqual(result.ranked.map((entry) => entry.product.id), [
    "same-second",
    "same-first",
    "orthogonal",
  ]);
  assert.deepEqual(result.ranked.map((entry) => entry.score), [1, 1, 0.5]);
  assert.ok(result.ranked.every((entry) => entry.mode === "clip-image"));
  assert.deepEqual(result.metadata, {
    primaryMode: "clip-image",
    fallbackMode: null,
    candidateCount: 3,
    indexedCandidateCount: 3,
    returnedCount: 3,
    referenceImageCount: 1,
    encodedReferenceImageCount: 1,
    contextItemCount: 0,
    contextVectorCount: 0,
    artifactAvailable: true,
    modelAvailable: true,
    embeddingCacheHits: 1,
    warnings: [],
  });
});

test("workspace anchors use cached CLIP vectors and are never returned as candidates", async () => {
  const products = [
    product("anchor", "workspace-a", { x: 0.1, y: 0.1 }),
    product("near", "workspace-a", { x: 0.12, y: 0.12 }),
    product("far", "workspace-a", { x: 0.9, y: 0.9 }),
  ];
  let embedCalled = false;
  const result = await rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    contextItemIds: ["anchor"],
    limit: 10,
  }, repositoryFor(products), {
    readEmbeddingArtifact: async () => visualArtifact({
      anchor: [1, 0],
      near: [0.95, 0.05],
      far: [0, 1],
    }),
    embedReferenceImages: async () => {
      embedCalled = true;
      return { vectors: [], cacheHits: 0, modelAvailable: false, warnings: [] };
    },
  });

  assert.equal(embedCalled, false);
  assert.deepEqual(result.ranked.map((entry) => entry.product.id), ["near", "far"]);
  assert.ok(result.ranked.every((entry) => entry.mode === "clip-anchor"));
  assert.equal(result.metadata.primaryMode, "clip-anchor");
  assert.equal(result.metadata.contextItemCount, 1);
  assert.equal(result.metadata.contextVectorCount, 1);
});

test("missing visual vectors fall back to hybrid anchors, then projection coordinates", async () => {
  const products = [
    product("anchor", "workspace-a", { x: 0.1, y: 0.1 }),
    product("hybrid", "workspace-a", { x: 0.8, y: 0.8 }),
    product("coordinate-only", "workspace-a", { x: 0.11, y: 0.12 }),
  ];
  const result = await rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    contextItemIds: ["anchor"],
  }, repositoryFor(products), {
    readEmbeddingArtifact: async () => visualArtifact({
      anchor: null,
      hybrid: null,
      "coordinate-only": null,
    }, {
      anchor: [1, 0],
      hybrid: [0.9, 0.1],
      "coordinate-only": [],
    }),
  });

  assert.deepEqual(result.ranked.map((entry) => [entry.product.id, entry.mode]), [
    ["hybrid", "hybrid-anchor"],
    ["coordinate-only", "pca-coordinate"],
  ]);
  assert.equal(result.metadata.primaryMode, "hybrid-anchor");
  assert.equal(result.metadata.fallbackMode, "pca-coordinate");
  assert.equal(result.metadata.indexedCandidateCount, 1);
});

test("an unavailable artifact produces an explicit PCA fallback without invoking image encoding", async () => {
  const products = [
    product("anchor", "workspace-a", { x: 0.1, y: 0.1 }),
    product("near", "workspace-a", { x: 0.12, y: 0.13 }),
    product("far", "workspace-a", { x: 0.9, y: 0.9 }),
  ];
  let embedCalled = false;
  const result = await rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    referenceImagePaths: ["/api/media/research-ref/1.png"],
    contextItemIds: ["anchor"],
  }, repositoryFor(products), {
    readEmbeddingArtifact: async () => null,
    embedReferenceImages: async () => {
      embedCalled = true;
      return { vectors: [[1, 0]], cacheHits: 0, modelAvailable: true, warnings: [] };
    },
  });

  assert.equal(embedCalled, false);
  assert.deepEqual(result.ranked.map((entry) => entry.product.id), ["near", "far"]);
  assert.ok(result.ranked.every((entry) => entry.mode === "pca-coordinate"));
  assert.equal(result.metadata.primaryMode, "pca-coordinate");
  assert.equal(result.metadata.artifactAvailable, false);
  assert.equal(result.metadata.modelAvailable, false);
  assert.match(result.metadata.warnings.join(" "), /No local visual embedding artifact/);
});

test("visual retrieval never expands a hard allowlist and clamps output to one hundred", async () => {
  const products = Array.from({ length: 130 }, (_, index) => product(
    `item-${String(index).padStart(3, "0")}`,
    "workspace-a",
  ));
  const eligibleProductIds = products.slice(10, 125).map(({ id }) => id);
  const result = await rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    referenceImagePaths: ["/api/media/research-ref/1.jpg"],
    eligibleProductIds,
    limit: 999,
  }, repositoryFor(products), {
    readEmbeddingArtifact: async () => null,
    embedReferenceImages: async () => {
      assert.fail("image encoding must not run without a candidate embedding artifact");
    },
  });

  assert.equal(result.metadata.candidateCount, 115);
  assert.equal(result.ranked.length, 100);
  assert.deepEqual(result.ranked.map((entry) => entry.product.id), eligibleProductIds.slice(0, 100));
  assert.ok(result.ranked.every((entry) => entry.mode === "catalog-order"));
});

test("arbitrary media paths and cross-workspace item ids are rejected before scoring", async () => {
  const products = [
    product("local", "workspace-a"),
    product("foreign", "workspace-b"),
  ];
  const repository = repositoryFor(products);
  let artifactRead = false;
  await assert.rejects(() => rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    referenceImagePaths: ["/tmp/not-app-owned.png"],
  }, repository, {
    readEmbeddingArtifact: async () => {
      artifactRead = true;
      return null;
    },
  }), /app-owned \/api\/media/);
  assert.equal(artifactRead, false);

  await assert.rejects(() => rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    contextItemIds: ["foreign"],
  }, repository), /Unknown visual context item/);
  await assert.rejects(() => rankWorkspaceByVisualReferences({
    workspaceId: "workspace-a",
    referenceImagePaths: ["/api/media/research-ref/1.webp"],
    eligibleProductIds: ["foreign"],
  }, repository), /Unknown eligible visual item/);
});
