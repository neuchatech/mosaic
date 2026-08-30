import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { catalogMediaPath, persistCatalogImages } from "../server/media";
import { setPublicNetworkTestHooksForTests } from "../server/public-html";
import { embedCatalogProducts } from "../server/visual-embeddings";
import { seedProducts } from "../src/catalog/seed";
import {
  VisualEmbeddingCache,
  buildHybridVector,
  runVisualEmbeddingPipeline,
  type ImageSourceLoader,
  type VisualImageEncoder,
  type VisualModelSpec,
} from "../src/embeddings";

const model: VisualModelSpec = {
  id: "test/clip",
  revision: "fixture",
  dtype: "q8",
  expectedDimension: 3,
};

async function temporaryCache(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wardrobe-visual-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("default visual image loading permits only pinned public HTTPS for shop items", async (t) => {
  const rootDir = await temporaryCache(t);
  let fetchCalls = 0;
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async () => {
      fetchCalls += 1;
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  });
  t.after(() => setPublicNetworkTestHooksForTests(null));
  const cache = new VisualEmbeddingCache({ rootDir });
  const context = { itemId: "shop-1", kind: "shop" as const };

  const image = await cache.getImage("https://cdn.example.com/look.jpg", { context });
  assert.equal(image.byteLength, 4);
  assert.equal(fetchCalls, 1);
  for (const source of [
    "file:///etc/passwd",
    "http://cdn.example.com/look.jpg",
    "data:image/jpeg;base64,AQIDBA==",
    "/api/media/shop-1/1.jpg",
    "https://private.invalid/look.jpg",
  ]) await assert.rejects(cache.getImage(source, { context }), /public HTTPS|local catalog media/i, source);
  assert.equal(fetchCalls, 1);
});

test("default visual image loading rejects private DNS before transport", async (t) => {
  const rootDir = await temporaryCache(t);
  let fetchCalls = 0;
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "169.254.169.254", family: 4 }],
    fetch: async () => { fetchCalls += 1; return new Response("unexpected"); },
  });
  t.after(() => setPublicNetworkTestHooksForTests(null));
  const cache = new VisualEmbeddingCache({ rootDir });
  await assert.rejects(
    cache.getImage("https://cdn.example.com/private.jpg", {
      context: { itemId: "shop-private", kind: "shop" },
    }),
    /non-public address/i,
  );
  assert.equal(fetchCalls, 0);
});

test("visual owned/reference media requires matching item context and app containment", async (t) => {
  const rootDir = await temporaryCache(t);
  const id = `owned-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const images = await persistCatalogImages(id, ["data:image/png;base64,AQIDBA=="]);
  t.after(() => rm(dirname(catalogMediaPath(id, "1.png")), { recursive: true, force: true }));
  const cache = new VisualEmbeddingCache({ rootDir });
  const source = images[0]!;

  const image = await cache.getImage(source, { context: { itemId: id, kind: "owned" } });
  assert.equal(image.byteLength, 4);
  assert.ok(await cache.getCachedImage(source, { context: { itemId: id, kind: "reference" } }));
  await assert.rejects(
    cache.getCachedImage(source, { context: { itemId: "another-item", kind: "owned" } }),
    /does not belong/i,
  );
  await assert.rejects(cache.getImage(source), /explicit owned\/reference item context/i);
  await assert.rejects(
    cache.getImage(`https://cdn.example.com/${id}.jpg`, { context: { itemId: id, kind: "reference" } }),
    /matching app-owned catalog media/i,
  );
  await assert.rejects(
    cache.getImage(`/api/media/${id}/../1.png`, { context: { itemId: id, kind: "owned" } }),
    /matching app-owned catalog media/i,
  );
});

test("visual cache deduplicates images and embeddings across items and resumed runs", async (t) => {
  const rootDir = await temporaryCache(t);
  let imageLoads = 0;
  const imageLoader: ImageSourceLoader = async () => {
    imageLoads += 1;
    return { bytes: Uint8Array.from([1, 2, 3, 4]), contentType: "image/jpeg" };
  };
  let encodes = 0;
  const encoder: VisualImageEncoder = {
    model,
    async encodeImage() { encodes += 1; return [3, 4, 0]; },
  };
  const items = [
    { id: "one", imageUrls: ["https://images.example.com/look.jpg"], metadataVector: [1, 0] },
    { id: "two", imageUrls: ["https://images.example.com/look.jpg"], metadataVector: [0, 1] },
  ];

  const first = await runVisualEmbeddingPipeline({
    items,
    cache: new VisualEmbeddingCache({ rootDir, imageLoader }),
    model,
    encoder,
  });
  assert.equal(imageLoads, 1);
  assert.equal(encodes, 1);
  assert.deepEqual(first.results.map(({ mode }) => mode), ["hybrid", "hybrid"]);
  assert.deepEqual(first.results[0]?.visualVector, [.6, .8, 0]);
  assert.equal(first.results[0]?.cacheHit, false);
  assert.equal(first.results[1]?.cacheHit, true);
  assert.equal(first.results[0]?.hybridVector.length, 5);

  const resumedEncoder: VisualImageEncoder = {
    model,
    async encodeImage() { throw new Error("cache miss during resumed run"); },
  };
  const resumed = await runVisualEmbeddingPipeline({
    items,
    cache: new VisualEmbeddingCache({ rootDir, imageLoader }),
    model,
    encoder: resumedEncoder,
  });
  assert.equal(imageLoads, 1);
  assert.equal(resumed.summary.cacheHits, 2);
  assert.ok(resumed.results.every(({ cacheHit }) => cacheHit));
});

test("per-image failures fall back to metadata and do not stop later items", async (t) => {
  const rootDir = await temporaryCache(t);
  const imageLoader: ImageSourceLoader = async (source) => ({
    bytes: new TextEncoder().encode(source),
    contentType: "image/jpeg",
  });
  let call = 0;
  const encoder: VisualImageEncoder = {
    model,
    async encodeImage() {
      call += 1;
      if (call === 1) throw new Error("fixture decode failure");
      return [1, 0, 0];
    },
  };
  const run = await runVisualEmbeddingPipeline({
    items: [
      { id: "broken", imageUrls: ["https://images.example.com/broken.jpg"], metadataVector: [2, 1] },
      { id: "healthy", imageUrls: ["https://images.example.com/healthy.jpg"], metadataVector: [1, 2] },
    ],
    cache: new VisualEmbeddingCache({ rootDir, imageLoader }),
    model,
    encoder,
  });

  assert.equal(run.results[0]?.mode, "metadata-only");
  assert.match(run.results[0]?.error ?? "", /fixture decode failure/);
  assert.equal(run.results[1]?.mode, "hybrid");
  assert.equal(run.summary.errors, 1);
  assert.equal(run.summary.processed, 2);
});

test("missing local model uses metadata only without downloading images", async (t) => {
  const rootDir = await temporaryCache(t);
  let imageLoads = 0;
  const run = await runVisualEmbeddingPipeline({
    items: [{ id: "offline", imageUrls: ["https://images.example.com/offline.jpg"], metadataVector: [3, 4] }],
    cache: new VisualEmbeddingCache({
      rootDir,
      imageLoader: async () => { imageLoads += 1; return { bytes: Uint8Array.from([1]) }; },
    }),
    model,
    encoder: null,
    modelError: "model absent",
  });

  assert.equal(imageLoads, 0);
  assert.equal(run.results[0]?.mode, "metadata-only");
  assert.deepEqual(run.results[0]?.hybridVector, [.6, .8]);
  assert.equal(run.summary.modelAvailable, false);
  assert.equal(run.summary.modelError, "model absent");
});

test("hybrid block norms encode the requested cosine-distance weights", () => {
  const hybrid = buildHybridVector([3, 4], [0, 12], { visual: .75, metadata: .25 });
  const visualNormSquared = hybrid.slice(0, 2).reduce((sum, value) => sum + value ** 2, 0);
  const metadataNormSquared = hybrid.slice(2).reduce((sum, value) => sum + value ** 2, 0);
  assert.ok(Math.abs(visualNormSquared - .75) < 1e-12);
  assert.ok(Math.abs(metadataNormSquared - .25) < 1e-12);
});

test("catalog adapter returns hybrid vectors without mutating product decisions", async (t) => {
  const cacheDir = await temporaryCache(t);
  const id = `owned-embedding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const images = await persistCatalogImages(id, ["data:image/jpeg;base64,AQIDBA=="]);
  t.after(() => rm(dirname(catalogMediaPath(id, "1.jpg")), { recursive: true, force: true }));
  const product = {
    ...seedProducts[0]!,
    id,
    sourceId: id,
    kind: "owned" as const,
    decision: "saved" as const,
    images,
  };
  const before = structuredClone(product);
  const encoder: VisualImageEncoder = {
    model,
    async encodeImage() { return [0, 1, 0]; },
  };
  const run = await embedCatalogProducts([product], { cacheDir, encoder });

  assert.equal(run.results[0]?.mode, "hybrid");
  assert.ok((run.results[0]?.metadataVector.length ?? 0) > 0);
  assert.deepEqual(product, before);
  assert.equal(product.decision, "saved");
});
