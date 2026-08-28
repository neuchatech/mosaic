import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  AcquisitionBlockedError,
  AcquisitionCancelledError,
  AcquisitionService,
  acquisitionClientView,
  classifyAccessBlock,
  mergeCollectedDetail,
  type AcquisitionRepository,
  type AcquisitionTarget,
  type DetailFetcher,
} from "../server/acquisition";
import {
  canonicalizeZalandoSize,
  normalizeZalandoSizes,
} from "../collector/adapters/zalando";
import { productSchema, type Product } from "../src/domain/catalog";
import { CatalogRepository } from "../server/repository";
import { createApp } from "../server/app";

const firstSeen = "2026-08-01T10:00:00.000Z";
const observed = "2026-08-28T10:00:00.000Z";

function product(id: string, overrides: Partial<Product> = {}): Product {
  return productSchema.parse({
    id,
    kind: "shop",
    source: "zalando-ch",
    sourceId: id,
    url: `https://www.zalando.ch/article-${id}.html`,
    brand: "Test",
    name: `Product ${id}`,
    description: "Existing description",
    price: 120,
    originalPrice: null,
    currency: "CHF",
    category: "Mailles",
    color: "Brun",
    colorFamily: "brown",
    fit: "relaxed",
    attributes: {
      previousSnapshot: true,
      sizeAvailabilityKnown: true,
      rawSizes: ["M", "L"],
    },
    materials: ["laine"],
    tags: ["saved-tag"],
    sizes: ["M", "L"],
    images: ["https://example.test/image.jpg"],
    available: true,
    stockStatus: "in_stock",
    stockCheckedAt: firstSeen,
    priceCheckedAt: firstSeen,
    sizesCheckedAt: firstSeen,
    decision: "saved",
    x: .2,
    y: .7,
    scores: { visual_match: 88 },
    importedAt: firstSeen,
    updatedAt: firstSeen,
    ...overrides,
  });
}

class MemoryRepository implements AcquisitionRepository {
  readonly products = new Map<string, Product>();

  constructor(products: Product[]) {
    for (const current of products) this.products.set(current.id, current);
  }

  getProduct(id: string): Product | null {
    return this.products.get(id) ?? null;
  }

  upsertProducts(products: Product[]): number {
    for (const current of products) this.products.set(current.id, productSchema.parse(current));
    return products.length;
  }
}

function ids(): () => string {
  let index = 0;
  return () => `acq_${++index}`;
}

test("Zalando sizes stay exact and canonicalize jeans width/length", () => {
  assert.equal(canonicalizeZalandoSize("L"), "L");
  assert.equal(canonicalizeZalandoSize("XL"), "XL");
  assert.equal(canonicalizeZalandoSize("W 32 / L 34"), "W32/L34");
  assert.equal(canonicalizeZalandoSize("32/34"), "W32/L34");
  assert.deepEqual(
    normalizeZalandoSizes(["Taille: L", "XL disponible", "W32/L34", "32 / 34", "48,50", "48,5", "Choisir"]),
    ["L", "XL", "W32/L34", "48", "50", "48.5"],
  );
});

test("common login and anti-bot interstitials stop without retry-oriented bypass", () => {
  assert.match(classifyAccessBlock({
    pageUrl: "https://accounts.zalando.ch/login",
    title: "Connexion",
  }) ?? "", /login|verification/i);
  assert.match(classifyAccessBlock({
    pageUrl: "https://www.zalando.ch/article.html",
    status: 200,
    title: "Just a moment...",
    bodyText: "Checking your browser before accessing the shop",
  }) ?? "", /CAPTCHA|verification/i);
  assert.equal(classifyAccessBlock({
    pageUrl: "https://www.zalando.ch/article.html",
    status: 200,
    title: "Pull en laine",
  }), null);
});

test("an unknown observation preserves the previous stock, sizes, price and decisions", () => {
  const before = product("preserve");
  const merged = mergeCollectedDetail(before, {
    url: before.url,
    name: before.name,
    price: null,
    stockStatus: "unknown",
    sizes: [],
    attributes: { detailCaptured: true, sizeAvailabilityKnown: false },
  }, observed);

  assert.equal(merged.stockStatus, "in_stock");
  assert.equal(merged.stockCheckedAt, firstSeen);
  assert.equal(merged.price, 120);
  assert.equal(merged.priceCheckedAt, firstSeen);
  assert.deepEqual(merged.sizes, ["M", "L"]);
  assert.equal(merged.sizesCheckedAt, firstSeen);
  assert.equal(merged.attributes.sizeAvailabilityKnown, true);
  assert.deepEqual(merged.attributes.rawSizes, ["M", "L"]);
  assert.equal(merged.available, true);
  assert.equal(merged.decision, "saved");
  assert.deepEqual(merged.scores, { visual_match: 88 });
  assert.equal(merged.x, .2);
  assert.equal(merged.y, .7);
});

test("a reliable detail observation updates stock, raw/canonical sizes and distinct timestamps", () => {
  const before = product("reliable");
  const stockAt = "2026-08-28T09:58:00.000Z";
  const priceAt = "2026-08-28T09:59:00.000Z";
  const sizesAt = "2026-08-28T10:00:00.000Z";
  const merged = mergeCollectedDetail(before, {
    url: before.url,
    name: "Updated",
    price: 99,
    rawSizes: ["Taille: XL", "W 32 / L 34"],
    sizes: ["XL", "W32/L34"],
    stockStatus: "in_stock",
    stockCheckedAt: stockAt,
    priceCheckedAt: priceAt,
    sizesCheckedAt: sizesAt,
    attributes: { detailCaptured: true, sizeAvailabilityKnown: true },
  }, observed);

  assert.equal(merged.name, "Updated");
  assert.equal(merged.price, 99);
  assert.equal(merged.stockCheckedAt, stockAt);
  assert.equal(merged.priceCheckedAt, priceAt);
  assert.equal(merged.sizesCheckedAt, sizesAt);
  assert.deepEqual(merged.sizes, ["XL", "W32/L34"]);
  assert.deepEqual(merged.attributes.rawSizes, ["Taille: XL", "W 32 / L 34"]);
});

test("the detail queue is serial, retries transient failures, and only retries blocks explicitly", async () => {
  const products = [product("one"), product("two"), product("three")];
  const repository = new MemoryRepository(products);
  const calls = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const fetcher: DetailFetcher = {
    async fetch(target) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const call = (calls.get(target.productId) ?? 0) + 1;
      calls.set(target.productId, call);
      active -= 1;
      if (target.productId === "one" && call === 1) throw new Error("temporary timeout");
      if (target.productId === "two" && call === 1) {
        throw new AcquisitionBlockedError("CAPTCHA detected; no bypass was attempted.");
      }
      return {
        url: target.url,
        name: `Refreshed ${target.productId}`,
        price: 80,
        stockStatus: "in_stock",
        stockCheckedAt: observed,
        priceCheckedAt: observed,
        sizesCheckedAt: observed,
        rawSizes: ["L"],
        sizes: ["L"],
        attributes: { sizeAvailabilityKnown: true },
      };
    },
  };
  const service = new AcquisitionService(repository, {
    fetcher,
    sameDomainDelayMs: 0,
    maxRetries: 2,
    idFactory: ids(),
  });
  const targets = products.map(({ id, url }) => ({ productId: id, url }));
  const started = service.start({ targets });
  const firstRun = await service.waitFor(started.id);

  assert.equal(maxActive, 1);
  assert.equal(firstRun.status, "blocked");
  assert.equal(firstRun.progress, 1);
  assert.equal(firstRun.items.find((item) => item.productId === "one")?.attempts, 2);
  assert.equal(firstRun.items.find((item) => item.productId === "two")?.attempts, 1);
  assert.equal(firstRun.items.find((item) => item.productId === "three")?.status, "succeeded");
  assert.equal(repository.getProduct("one")?.decision, "saved");

  service.retry(started.id);
  const retried = await service.waitFor(started.id);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.items.find((item) => item.productId === "two")?.attempts, 2);
  assert.equal(calls.get("one"), 2);
  assert.equal(calls.get("three"), 1);
  await service.close();
});

test("automatic retries are capped at two after the initial attempt", async () => {
  const current = product("failure");
  const repository = new MemoryRepository([current]);
  let calls = 0;
  const service = new AcquisitionService(repository, {
    fetcher: {
      async fetch() {
        calls += 1;
        throw new Error("network down");
      },
    },
    sameDomainDelayMs: 0,
    maxRetries: 20,
    idFactory: ids(),
  });
  const started = service.start({ targets: [{ productId: current.id, url: current.url }] });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "failed");
  assert.equal(calls, 3);
  assert.equal(finished.items[0]?.attempts, 3);
  await service.close();
});

test("cancel aborts the active page best-effort and cancels queued items", async () => {
  const products = [product("active"), product("waiting")];
  const repository = new MemoryRepository(products);
  let notifyStarted!: () => void;
  const startedFetching = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const fetcher: DetailFetcher = {
    async fetch(_target: AcquisitionTarget, { signal }) {
      notifyStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new AcquisitionCancelledError("cancelled")), { once: true });
      });
      return null;
    },
  };
  const service = new AcquisitionService(repository, {
    fetcher,
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = service.start({
    targets: products.map(({ id, url }) => ({ productId: id, url })),
  });
  await startedFetching;
  service.cancel(started.id);
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "cancelled");
  assert.deepEqual(finished.items.map((item) => item.status), ["cancelled", "cancelled"]);
  await service.close();
});

test("same-domain requests observe the configured delay", async () => {
  const products = [product("delay-one"), product("delay-two")];
  const repository = new MemoryRepository(products);
  let clock = Date.parse(observed);
  const sleeps: number[] = [];
  const service = new AcquisitionService(repository, {
    fetcher: {
      async fetch(target) {
        return { url: target.url, name: target.productId, stockStatus: "unknown" };
      },
    },
    sameDomainDelayMs: 1_500,
    now: () => new Date(clock),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    idFactory: ids(),
  });
  const started = service.start({
    targets: products.map(({ id, url }) => ({ productId: id, url })),
  });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(sleeps, [1_500]);
  await service.close();
});

test("SQLite persists queue progress and lets a fresh service hydrate the finished job", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const current = product("sqlite");
  repository.upsertProducts([current]);
  let sqliteFetches = 0;
  const fetcher: DetailFetcher = {
    async fetch(target) {
      sqliteFetches += 1;
      if (sqliteFetches === 1) throw new Error("temporary SQLite integration failure");
      return {
        url: target.url,
        name: "SQLite refreshed",
        price: 101,
        stockStatus: "in_stock",
        stockCheckedAt: observed,
        priceCheckedAt: observed,
        sizesCheckedAt: observed,
        rawSizes: ["XL"],
        sizes: ["XL"],
        attributes: { sizeAvailabilityKnown: true },
      };
    },
  };
  const firstService = new AcquisitionService(repository, {
    fetcher,
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = firstService.start({
    targets: [{ productId: current.id, url: current.url }],
    source: "sqlite-test",
  });
  const finished = await firstService.waitFor(started.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(repository.getAcquisitionJob(started.id)?.status, "succeeded");
  assert.equal(repository.listAcquisitionItems(started.id)[0]?.attempts, 2);
  assert.deepEqual(repository.getProduct(current.id)?.sizes, ["XL"]);
  assert.equal(repository.getProduct(current.id)?.decision, "saved");
  await firstService.close();

  const freshService = new AcquisitionService(repository, {
    fetcher: { async fetch() { throw new Error("should not run"); } },
    sameDomainDelayMs: 0,
  });
  const hydrated = freshService.get(started.id);
  assert.equal(hydrated?.status, "succeeded");
  assert.equal(hydrated?.progress, 1);
  assert.equal(hydrated?.items[0]?.attempts, 2);
  await freshService.close();
  db.close();
});

test("an interrupted persisted job resumes explicitly without repeating completed items", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const products = [product("already-done"), product("interrupted"), product("still-queued")];
  repository.upsertProducts(products);
  const job = repository.createAcquisitionJob({
    id: "resume-after-restart",
    source: "test",
    items: products.map((current, index) => ({
      id: `resume-item-${index}`,
      productId: current.id,
      url: current.url,
    })),
  });
  const completed = repository.claimNextAcquisitionItem(job.id)!;
  repository.recordAcquisitionItemAttempt(job.id, completed.id);
  repository.completeAcquisitionItem(job.id, completed.id);
  const interrupted = repository.claimNextAcquisitionItem(job.id)!;
  repository.recordAcquisitionItemAttempt(job.id, interrupted.id);

  const fetched: string[] = [];
  const service = new AcquisitionService(repository, {
    fetcher: {
      async fetch(target) {
        fetched.push(target.productId);
        return {
          url: target.url,
          name: `Recovered ${target.productId}`,
          stockStatus: "in_stock",
          stockCheckedAt: observed,
          sizesCheckedAt: observed,
          rawSizes: ["L"],
          sizes: ["L"],
          attributes: { sizeAvailabilityKnown: true },
        };
      },
    },
    sameDomainDelayMs: 0,
  });
  assert.equal(service.get(job.id)?.status, "running");
  const resumed = service.resume(job.id);
  assert.equal(resumed.status, "queued");
  const finished = await service.waitFor(job.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(fetched, ["interrupted", "still-queued"]);
  assert.deepEqual(
    repository.listAcquisitionItems(job.id).map((item) => item.attempts),
    [1, 2, 1],
  );
  await service.close();
  db.close();
});

test("hydrating and closing a persisted job is read-only until resume is explicit", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const current = product("read-only-hydration");
  repository.upsertProducts([current]);
  const persisted = repository.createAcquisitionJob({
    id: "read-only-job",
    source: "test",
    items: [{ id: "read-only-item", productId: current.id, url: current.url }],
  });
  const interrupted = repository.createAcquisitionJob({
    id: "read-only-running-job",
    source: "test",
    items: [{ id: "read-only-running-item", productId: current.id, url: current.url }],
  });
  repository.claimNextAcquisitionItem(interrupted.id);
  let fetches = 0;
  const service = new AcquisitionService(repository, {
    fetcher: {
      async fetch() {
        fetches += 1;
        throw new Error("hydration must not fetch");
      },
    },
    sameDomainDelayMs: 0,
  });

  assert.equal(service.get(persisted.id)?.status, "queued");
  assert.equal(service.get(interrupted.id)?.status, "running");
  assert.equal(service.list().find((job) => job.id === persisted.id)?.status, "queued");
  await service.close();

  assert.equal(fetches, 0);
  assert.equal(repository.getAcquisitionJob(persisted.id)?.status, "queued");
  assert.equal(repository.listAcquisitionItems(persisted.id)[0]?.status, "queued");
  assert.equal(repository.getAcquisitionJob(interrupted.id)?.status, "running");
  assert.equal(repository.listAcquisitionItems(interrupted.id)[0]?.status, "running");
  db.close();
});

test("the acquisition API uses one status contract and exposes explicit recovery", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(process.cwd(), "server/schema.sql"), "utf8"));
  const repository = new CatalogRepository(db);
  const current = product("api-resume");
  repository.upsertProducts([current]);
  repository.createAcquisitionJob({
    id: "api-job",
    source: "test",
    items: [{ id: "api-item", productId: current.id, url: current.url }],
  });
  const service = new AcquisitionService(repository, {
    fetcher: {
      async fetch(target) {
        return {
          url: target.url,
          name: "API recovered",
          stockStatus: "in_stock",
          stockCheckedAt: observed,
          sizesCheckedAt: observed,
          rawSizes: ["M"],
          sizes: ["M"],
          attributes: { sizeAvailabilityKnown: true },
        };
      },
    },
    sameDomainDelayMs: 0,
  });
  const app = createApp(repository, service);
  const listed = await (await app.request("/api/acquisition/jobs")).json() as Array<Record<string, unknown>>;
  assert.equal(listed[0]?.status, "queued");
  assert.equal(listed[0]?.rawStatus, "queued");
  assert.equal(listed[0]?.terminal, false);

  const resumeResponse = await app.request("/api/acquisition/jobs/api-job/resume", { method: "POST" });
  assert.equal(resumeResponse.status, 202);
  const resumeBody = await resumeResponse.json() as Record<string, unknown>;
  assert.equal(resumeBody.status, "queued");
  assert.equal(resumeBody.rawStatus, "queued");
  await service.waitFor("api-job");

  const completedResponse = await app.request("/api/acquisition/jobs/api-job");
  const completedBody = await completedResponse.json() as Record<string, unknown>;
  assert.equal(completedBody.status, "complete");
  assert.equal(completedBody.rawStatus, "succeeded");
  assert.equal(completedBody.terminal, true);
  assert.equal(completedBody.succeeded, 1);
  await service.close();
  db.close();
});

test("client status reports partial successes on a blocked terminal job", () => {
  const view = acquisitionClientView({
    id: "partial",
    source: "test",
    status: "blocked",
    total: 2,
    completed: 2,
    succeeded: 1,
    failed: 0,
    blocked: 1,
    cancelled: 0,
    progress: 1,
    items: [
      { id: "ok", productId: "ok", url: "https://www.zalando.ch/ok.html", status: "succeeded", attempts: 1 },
      { id: "blocked", productId: "blocked", url: "https://www.zalando.ch/blocked.html", status: "blocked", attempts: 1, error: "CAPTCHA" },
    ],
    createdAt: observed,
    updatedAt: observed,
  });
  assert.equal(view.status, "error");
  assert.equal(view.rawStatus, "blocked");
  assert.equal(view.partial, true);
  assert.equal(view.succeeded, 1);
  assert.equal(view.error, "CAPTCHA");
});
