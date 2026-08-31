import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { normalizeProduct } from "../collector/normalize";
import type { RawProduct } from "../collector/types";
import { AcquisitionService, type DetailFetcher } from "../server/acquisition";
import { createApp } from "../server/app";
import { assistantPlanSchema, finalizeAssistantPlan } from "../server/assistant-plan";
import { DiscoveryService, type DiscoveryFetcher } from "../server/discovery";
import { catalogMediaPath, deleteCatalogMedia } from "../server/media";
import { setPublicNetworkTestHooksForTests } from "../server/public-html";
import { CatalogRepository } from "../server/repository";

function memoryRepository() {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  return { db, repository: new CatalogRepository(db) };
}

function fakeDiscovery(repository: CatalogRepository) {
  const observedAt = new Date().toISOString();
  const fetcher: DiscoveryFetcher = {
    async fetch(request): Promise<RawProduct[]> {
      const prefix = (request.intent.query ?? "").toLocaleLowerCase().includes("jacket") ? "JACKET" : "PIPE";
      return [1, 2].map((ordinal) => ({
        sourceId: `${prefix}-${ordinal}`,
        url: `https://www.aboutyou.ch/p/example/${prefix.toLocaleLowerCase()}-${1000 + ordinal}`,
        brand: "Pipeline Studio",
        name: `${prefix === "JACKET" ? "Canvas jacket" : "Textured knit"} ${ordinal}`,
        description: "Brown textured knit for a local mood board.",
        price: 80 + ordinal,
        currency: "CHF",
        category: "Mailles",
        color: "Brown",
        sizes: ["M", "L"],
        rawSizes: ["M", "L"],
        images: [`https://images.example.com/pipeline-${ordinal}.jpg`],
        available: true,
        stockStatus: "in_stock",
        stockCheckedAt: observedAt,
        priceCheckedAt: observedAt,
        sizesCheckedAt: observedAt,
        attributes: { sizeAvailabilityKnown: true },
      }));
    },
  };
  return new DiscoveryService({
    fetcher,
    sameDomainDelayMs: 0,
    maxRetries: 0,
    onProducts(rawProducts, context) {
      const workspaceId = context.intent.workspaceId ?? "default-clothing";
      repository.upsertCollectedProducts(rawProducts.map((raw) => (
        normalizeProduct(context.intent.source, raw, workspaceId)
      )));
    },
  });
}

function fakeDetail(repository: CatalogRepository, productId: string): RawProduct {
  const product = repository.getProduct(productId)!;
  const observedAt = new Date().toISOString();
  return {
    sourceId: product.sourceId,
    url: product.url,
    brand: product.brand,
    name: product.name,
    description: product.description,
    price: product.price,
    originalPrice: product.originalPrice,
    currency: product.currency,
    category: product.category,
    color: product.color,
    colorFamily: product.colorFamily,
    fit: product.fit,
    materials: product.materials,
    tags: product.tags,
    sizes: ["M", "L"],
    rawSizes: ["M", "L"],
    images: product.images,
    available: true,
    stockStatus: "in_stock",
    stockCheckedAt: observedAt,
    priceCheckedAt: observedAt,
    sizesCheckedAt: observedAt,
    attributes: { ...product.attributes, sizeAvailabilityKnown: true, assistantEnriched: true },
  };
}

function fakeAcquisition(repository: CatalogRepository) {
  const fetcher: DetailFetcher = {
    async fetch(target): Promise<RawProduct> {
      return fakeDetail(repository, target.productId);
    },
  };
  return new AcquisitionService(repository, {
    fetcher,
    sameDomainDelayMs: 0,
    sameDomainJitterMs: 0,
    maxRetries: 0,
  });
}

async function waitForArtifact(repository: CatalogRepository, artifactId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const artifact = repository.getArtifact(artifactId);
    if (artifact && artifact.status !== "queued") return artifact;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return repository.getArtifact(artifactId);
}

async function waitForArtifactStatus(repository: CatalogRepository, artifactId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const artifact = repository.getArtifact(artifactId);
    if (artifact?.status === status) return artifact;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return repository.getArtifact(artifactId);
}

test("discover -> enrich -> mood board persists a queued continuation then fills the draft", async (t) => {
  const { db, repository } = memoryRepository();
  const discovery = fakeDiscovery(repository);
  const acquisition = fakeAcquisition(repository);
  const app = createApp(repository, acquisition, discovery);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  t.after(async () => {
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    await discovery.close();
    await acquisition.close();
    // Keep the in-memory fixture open until pending app callbacks settle.
  });

  const response = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "default-clothing",
      prompt: "Trouve 2 pulls sur About You en taille M puis crée un mood board",
    }),
  });
  assert.equal(response.status, 202);
  const queued = await response.json() as {
    action: string;
    artifact: { id: string; status: string; inputItemIds: string[] };
    jobs: Array<{ id: string }>;
    continuation: { status: string; jobIds: string[] };
    plan: { steps: Array<{ id: string; type: string }> };
  };
  assert.equal(queued.action, "artifact");
  assert.equal(queued.artifact.status, "queued");
  assert.deepEqual(queued.artifact.inputItemIds, []);
  assert.equal(queued.continuation.status, "queued");
  assert.deepEqual(queued.continuation.jobIds, queued.jobs.map((job) => job.id));
  assert.deepEqual(queued.plan.steps.map((step) => step.type), ["discover_adapter", "enrich", "artifact"]);

  await Promise.all(queued.jobs.map((job) => discovery.waitFor(job.id)));
  const artifact = await waitForArtifact(repository, queued.artifact.id);
  assert.ok(artifact);
  assert.equal(artifact.status, "draft", JSON.stringify(artifact, null, 2));
  assert.ok(artifact.inputItemIds.length > 0);
  assert.ok(artifact.inputItemIds.every((id) => repository.getProduct(id, "default-clothing")));
  assert.deepEqual(artifact.provenance.discoveryJobIds, queued.jobs.map((job) => job.id));
  const enrichmentJobs = acquisition.list("default-clothing");
  assert.equal(enrichmentJobs.length, 1);
  assert.equal(enrichmentJobs[0]?.status, "succeeded");
  assert.ok(enrichmentJobs[0]?.items.every((item) => item.status === "succeeded"));
  assert.ok(artifact.inputItemIds.every((id) => repository.getProduct(id)?.attributes.assistantEnriched === true));
  assert.equal(
    (artifact.provenance.assistantContinuation as { status?: string }).status,
    "draft",
  );
  assert.equal(
    (artifact.provenance.assistantContinuation as { enrichment?: { status?: string; jobId?: string } }).enrichment?.status,
    "succeeded",
  );
  assert.equal(
    (artifact.provenance.assistantContinuation as { enrichment?: { jobId?: string } }).enrichment?.jobId,
    enrichmentJobs[0]?.id,
  );
});

test("every upstream discovery is launched before one bounded enrichment and artifact", async (t) => {
  const { db, repository } = memoryRepository();
  const discovery = fakeDiscovery(repository);
  const acquisition = fakeAcquisition(repository);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  const rawPlan = assistantPlanSchema.parse({
    version: 1,
    action: "filter",
    primaryStepId: "artifact",
    title: "Combined board",
    message: "Two bounded searches, one enrichment, one artifact.",
    query: "combined board",
    sizePolicy: "explicit",
    sizes: ["M"],
    shopPolicy: "explicit",
    shops: ["aboutyou-ch"],
    pricePolicy: "all",
    minPrice: 0,
    maxPrice: 0,
    targetCount: 4,
    steps: [
      { id: "knits", type: "discover_adapter", title: "Find knits", dependsOn: [], query: "textured knit", sources: ["aboutyou-ch"], targetCount: 2 },
      { id: "jackets", type: "discover_adapter", title: "Find jackets", dependsOn: [], query: "canvas jacket", sources: ["aboutyou-ch"], targetCount: 2 },
      { id: "details", type: "enrich", title: "Verify details", dependsOn: ["knits", "jackets"], scope: "previous_step", itemIds: [], collectionIds: [], fields: ["availability", "sizes", "price"], targetCount: 4 },
      { id: "artifact", type: "artifact", title: "Create board", dependsOn: ["details"], scope: "previous_step", itemIds: [], collectionIds: [], mode: "draft", artifactKind: "mood_board", prompt: "combined board", targetCount: 4 },
    ],
  });
  const app = createApp(repository, acquisition, discovery, {
    assistantPlanner: async (input) => finalizeAssistantPlan(rawPlan, input, "heuristic"),
  });
  t.after(async () => {
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    await discovery.close();
    await acquisition.close();
    // Keep the in-memory fixture open until pending app callbacks settle.
  });

  const response = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "default-clothing", prompt: "Create a combined mood board from About You" }),
  });
  assert.equal(response.status, 202);
  const queued = await response.json() as {
    artifact: { id: string };
    jobs: Array<{ id: string }>;
  };
  assert.equal(queued.jobs.length, 2);
  await Promise.all(queued.jobs.map((job) => discovery.waitFor(job.id)));
  const artifact = await waitForArtifact(repository, queued.artifact.id);
  assert.equal(artifact?.status, "draft", JSON.stringify(artifact, null, 2));
  assert.equal(artifact?.inputItemIds.length, 4);
  assert.deepEqual(artifact?.provenance.pipelineStepIds, ["knits", "jackets", "details", "artifact"]);
  const continuation = artifact?.provenance.assistantContinuation as {
    jobIds?: string[];
    enrichment?: { stepIds?: string[]; status?: string };
  };
  assert.deepEqual(continuation.jobIds, queued.jobs.map((job) => job.id));
  assert.deepEqual(continuation.enrichment?.stepIds, ["details"]);
  assert.equal(continuation.enrichment?.status, "succeeded");
  assert.equal(acquisition.list("default-clothing").length, 1);
});

test("a failed persisted enrichment can be retried and completes its artifact", async (t) => {
  const { db, repository } = memoryRepository();
  const discovery = fakeDiscovery(repository);
  let allowDetails = false;
  const acquisition = new AcquisitionService(repository, {
    fetcher: {
      async fetch(target) {
        return allowDetails ? fakeDetail(repository, target.productId) : null;
      },
    },
    sameDomainDelayMs: 0,
    sameDomainJitterMs: 0,
    maxRetries: 0,
  });
  const app = createApp(repository, acquisition, discovery);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  t.after(async () => {
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    await discovery.close();
    await acquisition.close();
    // Keep the in-memory fixture open until pending app callbacks settle.
  });

  const response = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "default-clothing",
      prompt: "Trouve des pulls sur About You en taille M puis crée un mood board",
    }),
  });
  assert.equal(response.status, 202);
  const queued = await response.json() as { artifact: { id: string }; jobs: Array<{ id: string }> };
  await Promise.all(queued.jobs.map((job) => discovery.waitFor(job.id)));
  const failed = await waitForArtifact(repository, queued.artifact.id);
  assert.equal(failed?.status, "failed");
  const enrichmentJobId = (failed?.provenance.assistantContinuation as {
    enrichment?: { jobId?: string };
  }).enrichment?.jobId;
  assert.ok(enrichmentJobId);
  assert.equal(acquisition.get(enrichmentJobId)?.status, "failed");

  allowDetails = true;
  acquisition.retry(enrichmentJobId);
  await acquisition.waitFor(enrichmentJobId);
  const recovered = await waitForArtifactStatus(repository, queued.artifact.id, "draft");
  assert.equal(recovered?.status, "draft");
  assert.ok(recovered?.inputItemIds.length);
  assert.equal(
    (recovered?.provenance.assistantContinuation as { enrichment?: { status?: string } }).enrichment?.status,
    "succeeded",
  );
});

test("unsupported post-discovery outcomes are rejected before any discovery job starts", async (t) => {
  const { db, repository } = memoryRepository();
  const discovery = fakeDiscovery(repository);
  const acquisition = fakeAcquisition(repository);
  const app = createApp(repository, acquisition, discovery);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  t.after(async () => {
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    await discovery.close();
    await acquisition.close();
    // Keep the in-memory fixture open until pending app callbacks settle.
  });

  for (const prompt of [
    "Trouve 2 pulls sur About You puis crée une collection",
    "Trouve 2 pulls sur About You puis compare-les",
    "Trouve 2 pulls sur About You puis trouve des articles similaires",
    "Trouve 2 pulls sur About You et enrichis leurs détails",
  ]) {
    const response = await app.request("/api/codex/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "default-clothing", prompt }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { action: string; jobs?: unknown[]; message?: string };
    assert.equal(payload.action, "clarify");
    assert.equal(payload.jobs, undefined);
    assert.match(payload.message ?? "", /pas lancée|lance d’abord|termine d’abord/i);
  }
  assert.equal(discovery.list(20).length, 0);
  assert.equal(acquisition.list("default-clothing").length, 0);
  assert.equal(repository.listCollections("default-clothing").filter((collection) => !collection.systemKey).length, 0);
});

test("import_urls -> compare uses the successfully imported products", async (t) => {
  const { db, repository } = memoryRepository();
  const app = createApp(repository);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async (url) => {
      const ordinal = url.includes("second") ? 2 : 1;
      return new Response(`<!doctype html><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        sku: `COMPARE-${ordinal}`,
        name: `Compare item ${ordinal}`,
        brand: { name: "Comparison Shop" },
        image: [`https://images.example.com/compare-${ordinal}.jpg`],
        offers: { price: String(100 + ordinal * 25), priceCurrency: "CHF", availability: "https://schema.org/InStock" },
      })}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  t.after(() => {
    setPublicNetworkTestHooksForTests(null);
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    // Keep the in-memory fixture open until pending app callbacks settle.
  });

  const first = "https://shop.example.com/products/first";
  const second = "https://shop.example.com/products/second";
  const response = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "default-clothing",
      prompt: `Compare ces deux liens et résume les différences ${first} ${second}`,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    action: string;
    products: Array<{ id: string; name: string }>;
    summary: { count: number };
  };
  assert.equal(payload.action, "compare");
  assert.equal(payload.products.length, 2);
  assert.equal(payload.summary.count, 2);
  assert.deepEqual(new Set(payload.products.map((product) => product.name)), new Set(["Compare item 1", "Compare item 2"]));
});

test("artifact images stay in app-owned media across a repository reload", async (t) => {
  const { db, repository } = memoryRepository();
  const app = createApp(repository);
  const bytes = Buffer.from("local artifact image");
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const mediaIds: string[] = [];
  t.after(async () => {
    await Promise.all(mediaIds.map((id) => deleteCatalogMedia(id)));
    // createApp owns default background services; the in-memory fixture is
    // intentionally left open until the process exits.
  });

  const response = await app.request("/api/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "../../client-controlled",
      workspaceId: "default-clothing",
      type: "other",
      name: "Private image draft",
      status: "draft",
      localFiles: ["/tmp/client-controlled.png"],
      images: [{ name: "reference.png", dataUrl }],
      provenance: { privacy: "local-first" },
    }),
  });
  assert.equal(response.status, 201);
  const artifact = await response.json() as { id: string; localFiles: string[] };
  assert.match(artifact.id, /^artifact-[0-9a-f-]{36}$/);
  const mediaId = `artifact-${artifact.id}`;
  mediaIds.push(mediaId);
  assert.deepEqual(artifact.localFiles, [`/api/media/${mediaId}/1.png`]);
  assert.deepEqual(readFileSync(catalogMediaPath(mediaId, "1.png")), bytes);

  const row = db.prepare("SELECT local_files_json, provenance_json FROM artifacts WHERE id = ?").get(artifact.id) as {
    local_files_json: string;
    provenance_json: string;
  };
  assert.ok(!`${row.local_files_json}${row.provenance_json}`.includes("data:image/"));
  assert.ok(!row.local_files_json.includes("client-controlled"));
  const reloaded = new CatalogRepository(db).getArtifact(artifact.id);
  assert.deepEqual(reloaded?.localFiles, artifact.localFiles);

  const arbitraryMediaPatch = await app.request(`/api/artifacts/${encodeURIComponent(artifact.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "default-clothing",
      localFiles: ["/tmp/replaced-by-client.png"],
    }),
  });
  assert.equal(arbitraryMediaPatch.status, 400);
  assert.deepEqual(repository.getArtifact(artifact.id)?.localFiles, artifact.localFiles);

  const deleted = await app.request(`/api/artifacts/${encodeURIComponent(artifact.id)}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(catalogMediaPath(mediaId, "1.png")), false);
});

test("assistant-created artifacts persist uploaded image references locally", async (t) => {
  const { db, repository } = memoryRepository();
  const app = createApp(repository);
  const originalCodexPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/definitely/missing/codex";
  const dataUrl = `data:image/webp;base64,${Buffer.from("assistant image").toString("base64")}`;
  let mediaId = "";
  t.after(async () => {
    // Let createApp's startup recovery microtasks settle before closing the fixture DB.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (mediaId) await deleteCatalogMedia(mediaId);
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
    // createApp owns default background services; keep this fixture alive for
    // their queued startup callbacks.
  });

  const response = await app.request("/api/codex/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "default-clothing",
      prompt: "Crée un brouillon de mood board avec cette image",
      images: [{ name: "mood.webp", dataUrl }],
    }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { action: string; artifact: { id: string; localFiles: string[] } };
  assert.equal(payload.action, "artifact");
  mediaId = `artifact-${payload.artifact.id}`;
  assert.deepEqual(payload.artifact.localFiles, [`/api/media/${mediaId}/1.webp`]);
  const row = db.prepare("SELECT local_files_json FROM artifacts WHERE id = ?").get(payload.artifact.id) as { local_files_json: string };
  assert.ok(!row.local_files_json.includes("data:image/"));
});
