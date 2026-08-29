import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decisionSchema, filterSpecSchema, productPatchSchema, productSchema } from "../src/domain/catalog";
import { stableProductId } from "../src/domain/ids";
import { normalizeProduct } from "../collector/normalize";
import { adapterFor } from "../collector/registry";
import type { DiscoveryIntent, RawProduct } from "../collector/types";
import { AcquisitionService, acquisitionClientView } from "./acquisition";
import { catalogMediaPath, catalogMediaType, persistCatalogImages } from "./media";
import { generateOutfits } from "./outfit-generator";
import { projectCompactCached } from "./projection-cache";
import { fetchPublicHtml } from "./public-html";
import { CatalogRepository } from "./repository";
import { createFilterWithCodex } from "./codex-bridge";
import { createDiscoveryPlanWithCodex } from "./codex-discovery";
import { DiscoveryService, FileDiscoveryJobStore, PlaywrightDiscoveryFetcher } from "./discovery";
import { getEmbeddingJob, startEmbeddingJob } from "./embedding-job";
import { attachImageAspectRatios } from "./image-aspect-ratios";
import { getVisualSelection, startVisualSelection } from "./visual-selection";

const catalogItemFieldsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  images: z.array(z.string().min(1)).min(1).max(6),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  color: z.string().max(100).optional(),
  colorFamily: z.string().max(100).optional(),
  fit: z.string().max(100).optional(),
  tags: z.array(z.string().max(80)).max(40).optional(),
});

const personalItemSchema = catalogItemFieldsSchema.extend({
  kind: z.enum(["owned", "reference"]),
});

const referenceItemSchema = catalogItemFieldsSchema.extend({
  attributes: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ).optional(),
});

const publicProductUrlSchema = z.object({
  url: z.string().url().max(2_000),
});

const GENERIC_PRODUCT_HOSTS = [
  "aboutyou.ch",
  "arket.com",
  "asos.com",
  "bluetomato.com",
  "breuninger.com",
  "cos.com",
  "farfetch.com",
  "galaxus.ch",
  "globus.ch",
  "hm.com",
  "mango.com",
  "manor.ch",
  "massimodutti.com",
  "mrporter.com",
  "pkz.ch",
  "ssense.com",
  "uniqlo.com",
  "yoox.com",
  "zalando.ch",
  "zara.com",
] as const;

function allowedPublicProductHost(hostname: string): boolean {
  return GENERIC_PRODUCT_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function outfitView(board: ReturnType<CatalogRepository["saveOutfitBoard"]>) {
  return {
    ...board,
    productIds: board.items.map((item) => item.productId),
  };
}

function planSearchUsesGarmentSizes(search: { source: string; category: string; query: string }): boolean {
  if (search.source !== "zalando-ch") return false;
  return !/access|chauss|shoe|sneaker|boot|collier|necklace|jewel|bijou|bonnet|beanie|casquette|sac|bag|ceinture|belt|écharpe|scarf|lunette/i
    .test(`${search.category} ${search.query}`);
}

function createDiscoveryService(
  repository: CatalogRepository,
  acquisition: AcquisitionService,
  options: { headed?: boolean } = {},
): DiscoveryService {
  return new DiscoveryService({
    ...(options.headed ? { fetcher: new PlaywrightDiscoveryFetcher({ headed: true }) } : {}),
    store: new FileDiscoveryJobStore(),
    isKnownProduct(raw: RawProduct, source) {
      return repository.listProducts({ limit: 10_000 }).some((product) => (
        product.source === source
        && ((raw.sourceId && product.sourceId === raw.sourceId) || product.url === raw.url)
      ));
    },
    async onProducts(rawProducts, context) {
      const products = rawProducts.map((raw) => normalizeProduct(context.intent.source, raw));
      repository.upsertCollectedProducts(products);
      const allProducts = repository.listProducts({ limit: 10_000 });
      repository.replaceCoordinates(projectCompactCached(allProducts));
      if (!context.intent.sizes?.length) return;
      for (let offset = 0; offset < products.length; offset += 120) {
        const targets = products.slice(offset, offset + 120).map((product) => ({
          productId: product.id,
          url: product.url,
        }));
        if (targets.length) {
          const detailJob = acquisition.start({ targets, source: `discovery:${context.jobId}` });
          // Keep listing and product-detail traffic serialized on the same local
          // workflow; this avoids two independent workers hitting Zalando at once.
          await acquisition.waitFor(detailJob.id);
        }
      }
    },
  });
}

export function createApp(
  repository = new CatalogRepository(),
  acquisition = new AcquisitionService(repository),
  discovery = createDiscoveryService(repository, acquisition),
) {
  const app = new Hono();
  let interactiveDiscovery: DiscoveryService | null = null;
  const interactiveDiscoveryJobs = new Set<string>();
  const getInteractiveDiscovery = () => {
    interactiveDiscovery ??= createDiscoveryService(repository, acquisition, { headed: true });
    return interactiveDiscovery;
  };
  const discoveryForJob = (id: string) => interactiveDiscoveryJobs.has(id)
    ? getInteractiveDiscovery()
    : discovery;
  const startDiscoveryIntents = (intents: DiscoveryIntent[]) => {
    const backgroundIntents = intents.filter((intent) => intent.source !== "zalando-ch");
    const visibleIntents = intents.filter((intent) => intent.source === "zalando-ch");
    const jobs = backgroundIntents.length ? discovery.startBatch({ intents: backgroundIntents }) : [];
    if (visibleIntents.length) {
      const visibleJobs = getInteractiveDiscovery().startBatch({ intents: visibleIntents });
      visibleJobs.forEach((job) => interactiveDiscoveryJobs.add(job.id));
      jobs.push(...visibleJobs);
    }
    return jobs;
  };
  app.use("/api/*", cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));

  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/api/media/:itemId/:fileName", async (context) => {
    try {
      const fileName = context.req.param("fileName");
      const bytes = await readFile(catalogMediaPath(context.req.param("itemId"), fileName));
      context.header("content-type", catalogMediaType(fileName));
      context.header("cache-control", "private, max-age=31536000, immutable");
      return context.body(new Uint8Array(bytes));
    } catch {
      return context.json({ error: "media not found" }, 404);
    }
  });
  app.get("/api/stats", (context) => context.json(repository.stats()));
  app.get("/api/embeddings/job", (context) => context.json(getEmbeddingJob()));
  app.post("/api/embeddings/job", (context) => context.json(startEmbeddingJob(repository), 202));
  app.get("/api/products", async (context) => {
    const search = context.req.query("search");
    const limit = Number(context.req.query("limit") ?? 1000);
    return context.json(await attachImageAspectRatios(projectCompactCached(repository.listProducts({ search, limit }))));
  });
  app.post("/api/products/import", async (context) => {
    const body = await context.req.json();
    const products = productSchema.array().parse(body.products ?? body);
    return context.json({ imported: repository.upsertProducts(products) }, 201);
  });
  app.post("/api/products/import-url", async (context) => {
    const parsed = publicProductUrlSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid product URL", issues: parsed.error.issues }, 400);
    const requested = new URL(parsed.data.url);
    if (requested.protocol !== "https:" || !allowedPublicProductHost(requested.hostname)) {
      return context.json({
        error: "shop host is not enabled for generic import",
        supportedHosts: GENERIC_PRODUCT_HOSTS,
      }, 400);
    }
    try {
      const response = await fetchPublicHtml(requested.href, {
        signal: context.req.raw.signal,
        allowedHost: allowedPublicProductHost,
      });
      const current = new URL(response.url);
      if (!allowedPublicProductHost(current.hostname)) {
        throw new Error(`Product page redirected to unsupported host ${current.hostname}.`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Product page returned HTTP ${response.status}.`);
      }
      if (!response.contentType.toLocaleLowerCase().includes("html")) {
        throw new Error(`Product page returned ${response.contentType || "an unknown content type"}.`);
      }
      const adapter = adapterFor(current, true);
      if (!adapter.extractDetailHtml) throw new Error("This shop needs a dedicated interactive reader.");
      const raw = await adapter.extractDetailHtml(response.html, current.href);
      if (!raw) throw new Error("No public Product JSON-LD was found on this page.");
      const product = normalizeProduct(adapter.id, raw);
      repository.upsertCollectedProducts([product]);
      repository.replaceCoordinates(projectCompactCached(repository.listProducts({ limit: 10_000 })));
      return context.json(product, 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "product import failed" }, 422);
    }
  });
  app.post("/api/query", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    const products = repository.listProducts({ filter, limit: filter.limit });
    return context.json(await attachImageAspectRatios(projectCompactCached(products)));
  });
  app.post("/api/references", async (context) => {
    const parsed = referenceItemSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid reference", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    const sourceId = crypto.randomUUID();
    const id = stableProductId("reference", sourceId);
    const now = new Date().toISOString();
    let images: string[];
    try {
      images = await persistCatalogImages(id, input.images);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "invalid reference image" }, 400);
    }
    const reference = productSchema.parse({
      id,
      kind: "reference",
      source: "reference",
      sourceId,
      url: `https://reference.local/${sourceId}`,
      brand: "Référence",
      name: input.name,
      description: input.description ?? "",
      price: null,
      originalPrice: null,
      currency: "CHF",
      category: input.category ?? "Référence",
      color: input.color ?? "Inconnue",
      colorFamily: input.colorFamily ?? "unknown",
      fit: input.fit ?? "unknown",
      attributes: input.attributes ?? {},
      materials: [],
      tags: input.tags ?? [],
      sizes: [],
      images,
      available: true,
      stockStatus: "not_applicable",
      decision: "saved",
      x: .5,
      y: .5,
      scores: {},
      importedAt: now,
      updatedAt: now,
    });
    repository.upsertProducts([reference]);
    return context.json(repository.getProduct(id), 201);
  });
  app.patch("/api/products/:id", async (context) => {
    const patch = productPatchSchema.parse(await context.req.json());
    const id = context.req.param("id");
    if (!repository.getProduct(id)) return context.json({ error: "product not found" }, 404);
    if (patch.decision) {
      const result = repository.setDecision([id], patch.decision);
      const rest = { ...patch, decision: undefined };
      if (Object.values(rest).some((value) => value !== undefined)) repository.patchProducts([id], rest);
      return context.json({ updated: 1, product: repository.getProduct(id), actionId: result.actionId });
    }
    const updated = repository.patchProducts([id], patch);
    return context.json({ updated, product: repository.getProduct(id) });
  });
  app.post("/api/products/bulk-decision", async (context) => {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), decision: decisionSchema }).parse(await context.req.json());
    const result = repository.setDecision(body.ids, body.decision);
    return context.json(result);
  });
  app.post("/api/actions/undo", async (context) => {
    const body = z.object({ actionId: z.string().uuid().optional() }).parse(await context.req.json());
    const result = body.actionId ? repository.undoDecision(body.actionId) : repository.undoLastDecision();
    if (!result) return context.json({ error: "action not found or already undone" }, 409);
    return context.json({ ...result, product: result.products[0] ?? null });
  });

  app.post("/api/personal-items", async (context) => {
    const parsed = personalItemSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid personal item", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    const sourceId = crypto.randomUUID();
    const id = stableProductId(input.kind, sourceId);
    const now = new Date().toISOString();
    let images: string[];
    try {
      images = await persistCatalogImages(id, input.images);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "invalid personal item image" }, 400);
    }
    const item = productSchema.parse({
      id,
      kind: input.kind,
      source: input.kind,
      sourceId,
      url: `https://${input.kind}.local/${sourceId}`,
      brand: input.kind === "owned" ? "Mon dressing" : "Référence",
      name: input.name,
      description: input.description ?? "",
      price: null,
      originalPrice: null,
      currency: "CHF",
      category: input.category ?? (input.kind === "reference" ? "Références" : "Autre"),
      color: input.color ?? "Inconnue",
      colorFamily: input.colorFamily ?? "unknown",
      fit: input.fit ?? "unknown",
      attributes: {},
      materials: [],
      tags: input.tags ?? [],
      sizes: [],
      images,
      available: true,
      stockStatus: "not_applicable",
      decision: input.kind === "owned" ? "owned" : "saved",
      x: .5,
      y: .5,
      scores: {},
      importedAt: now,
      updatedAt: now,
    });
    repository.upsertProducts([item]);
    return context.json(repository.getProduct(id), 201);
  });
  app.get("/api/filters", (context) => context.json(repository.listFilters()));
  app.post("/api/filters", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    return context.json(repository.saveFilter(filter), 201);
  });
  app.get("/api/views", (context) => context.json(repository.listViews()));
  app.post("/api/views", async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Vue sans nom";
    const filter = body.filter ? filterSpecSchema.parse(body.filter) : filterSpecSchema.parse({
      id: `view_filter_${id}`,
      name,
      where: { type: "group", conjunction: "and", children: [] },
      limit: 5000,
    });
    return context.json(repository.saveView({ id, name, filter, state: body }), 201);
  });
  app.delete("/api/views/:id", (context) => repository.deleteView(context.req.param("id"))
    ? context.json({ deleted: true })
    : context.json({ error: "view not found" }, 404));

  app.get("/api/discovery/jobs", (context) => {
    const requestedLimit = Number(context.req.query("limit") ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 20;
    const normal = discovery.list(limit);
    if (!interactiveDiscovery) return context.json(normal);
    const interactiveById = new Map(interactiveDiscovery.list(limit).map((job) => [job.id, job]));
    return context.json(normal.map((job) => interactiveDiscoveryJobs.has(job.id) ? interactiveById.get(job.id) ?? job : job));
  });
  app.post("/api/discovery/jobs", async (context) => {
    const body = await context.req.json<{ intent?: DiscoveryIntent; intents?: DiscoveryIntent[] }>();
    const intents = body.intents ?? (body.intent ? [body.intent] : []);
    try {
      const jobs = startDiscoveryIntents(intents);
      return context.json({ jobs }, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "discovery unavailable" }, 400);
    }
  });
  app.get("/api/discovery/jobs/:id", (context) => {
    const job = discoveryForJob(context.req.param("id")).get(context.req.param("id"));
    return job ? context.json(job) : context.json({ error: "discovery job not found" }, 404);
  });
  app.post("/api/discovery/jobs/:id/cancel", (context) => {
    try { return context.json(discoveryForJob(context.req.param("id")).cancel(context.req.param("id"))); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "cancel failed" }, 404); }
  });
  app.post("/api/discovery/jobs/:id/retry", (context) => {
    const id = context.req.param("id");
    const interactive = context.req.query("interactive") === "1";
    if (interactive) interactiveDiscoveryJobs.add(id);
    try { return context.json(discoveryForJob(id).retry(id), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "retry failed" }, 409); }
  });
  app.post("/api/discovery/jobs/:id/resume", (context) => {
    const id = context.req.param("id");
    const interactive = context.req.query("interactive") === "1";
    if (interactive) interactiveDiscoveryJobs.add(id);
    try { return context.json(discoveryForJob(id).resume(id), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "resume failed" }, 409); }
  });

  app.get("/api/acquisition/jobs", (context) => {
    const requestedLimit = Number(context.req.query("limit") ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 20;
    return context.json(acquisition.list().slice(0, limit).map(acquisitionClientView));
  });
  app.post("/api/acquisition/jobs", async (context) => {
    const body = z.object({ productIds: z.array(z.string().min(1)).min(1).max(120) }).parse(await context.req.json());
    const seenUrls = new Set<string>();
    const targets = body.productIds.flatMap((id) => {
      const product = repository.getProduct(id);
      if (product?.kind !== "shop" || seenUrls.has(product.url)) return [];
      seenUrls.add(product.url);
      return [{ productId: product.id, url: product.url }];
    });
    if (!targets.length) return context.json({ error: "no refreshable shop products" }, 400);
    try { return context.json(acquisitionClientView(acquisition.start({ targets })), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "acquisition unavailable" }, 400); }
  });
  app.post("/api/acquisition/jobs/unknown-sizes", (context) => {
    const garmentCategories = new Set(["Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts"]);
    const freshAfter = Date.now() - 48 * 60 * 60 * 1_000;
    const seenUrls = new Set<string>();
    const targets = repository.listProducts({ limit: 10_000 })
      .filter((product) => product.kind === "shop" && product.decision !== "owned" && garmentCategories.has(product.category))
      .filter((product) => !product.sizesCheckedAt || Date.parse(product.sizesCheckedAt) < freshAfter)
      .sort((left, right) => {
        const leftPriority = left.decision === "saved" ? 0 : 1;
        const rightPriority = right.decision === "saved" ? 0 : 1;
        return leftPriority - rightPriority || left.importedAt.localeCompare(right.importedAt);
      })
      .flatMap((product) => {
        if (seenUrls.has(product.url)) return [];
        seenUrls.add(product.url);
        return [{ productId: product.id, url: product.url }];
      })
      .slice(0, 120);
    if (!targets.length) return context.json({ error: "no garment needs a size refresh" }, 400);
    try { return context.json(acquisitionClientView(acquisition.start({ targets, source: "size-enrichment" })), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "size acquisition unavailable" }, 400); }
  });
  app.get("/api/acquisition/jobs/:id", (context) => {
    const job = acquisition.get(context.req.param("id"));
    if (!job) return context.json({ error: "acquisition job not found" }, 404);
    return context.json(acquisitionClientView(job));
  });
  app.post("/api/acquisition/jobs/:id/retry", (context) => {
    try { return context.json(acquisitionClientView(acquisition.retry(context.req.param("id"))), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "retry failed" }, 409); }
  });
  app.post("/api/acquisition/jobs/:id/resume", (context) => {
    try { return context.json(acquisitionClientView(acquisition.resume(context.req.param("id"))), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "resume failed" }, 409); }
  });
  app.post("/api/acquisition/jobs/:id/cancel", (context) => {
    try { return context.json(acquisitionClientView(acquisition.cancel(context.req.param("id")))); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "cancel failed" }, 404); }
  });

  app.get("/api/outfit-boards", (context) => context.json(repository.listOutfitBoards().map(outfitView)));
  app.post("/api/outfit-boards", async (context) => {
    const body = z.object({
      id: z.string().min(1).optional(),
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2000).optional(),
      productIds: z.array(z.string().min(1)).min(1).max(20),
    }).parse(await context.req.json());
    const board = repository.saveOutfitBoard({
      id: body.id ?? crypto.randomUUID(),
      name: body.name,
      description: body.description,
      items: [...new Set(body.productIds)].map((productId, position) => ({ productId, position })),
    });
    return context.json(outfitView(board), 201);
  });
  app.post("/api/outfit-boards/generate", async (context) => {
    const body = z.object({ anchorProductId: z.string().min(1), maxOutfits: z.number().int().min(1).max(3).default(3) }).parse(await context.req.json());
    const anchor = repository.getProduct(body.anchorProductId);
    if (!anchor) return context.json({ error: "anchor product not found" }, 404);
    const generated = generateOutfits(anchor, repository.listProducts({ limit: 10_000 }), body.maxOutfits);
    const boards = generated.map((outfit) => repository.saveOutfitBoard({
      id: crypto.randomUUID(),
      name: outfit.title,
      description: `Compatibilité ${outfit.compatibilityScore}/100 · nouveauté ${outfit.noveltyScore}/100`,
      metadata: {
        anchorProductId: outfit.anchorProductId,
        compatibilityScore: outfit.compatibilityScore,
        noveltyScore: outfit.noveltyScore,
        missingRoles: outfit.missingRoles,
      },
      items: outfit.items.map((item, position) => ({ productId: item.productId, role: item.role, position, notes: item.reason })),
    }));
    return context.json(boards.map(outfitView), 201);
  });
  app.delete("/api/outfit-boards/:id", (context) => repository.deleteOutfitBoard(context.req.param("id"))
    ? context.json({ deleted: true })
    : context.json({ error: "outfit board not found" }, 404));

  app.get("/api/export", (context) => context.json({
    exportedAt: new Date().toISOString(),
    products: repository.listProducts({ limit: 10_000 }),
    views: repository.listViews(),
    outfits: repository.listOutfitBoards().map(outfitView),
  }));
  app.post("/api/codex/filter", async (context) => {
    const body = await context.req.json<{ prompt?: string }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    try {
      return context.json(await createFilterWithCodex(body.prompt, repository), 201);
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex bridge failed" }, 500);
    }
  });
  app.post("/api/codex/discovery-plan", async (context) => {
    const body = await context.req.json<{ prompt?: string }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    try {
      return context.json(await createDiscoveryPlanWithCodex(body.prompt), 201);
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex discovery planning failed" }, 500);
    }
  });
  app.post("/api/codex/discover", async (context) => {
    const body = await context.req.json<{ prompt?: string }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    try {
      const plan = await createDiscoveryPlanWithCodex(body.prompt);
      const intents: DiscoveryIntent[] = plan.searches.map((search) => ({
        source: search.source,
        query: search.query,
        category: search.category,
        maxItems: search.maxItems,
        sizeMode: plan.sizeMode,
        ...(planSearchUsesGarmentSizes(search) ? { sizes: plan.sizes } : {}),
        ...(search.minPrice > 0 ? { minPrice: search.minPrice } : {}),
        ...(search.maxPrice > 0 ? { maxPrice: search.maxPrice } : {}),
      }));
      const jobs = startDiscoveryIntents(intents);
      return context.json({ plan, jobs }, 202);
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex discovery failed" }, 500);
    }
  });
  app.post("/api/codex/visual-select", async (context) => {
    const body = await context.req.json<{
      prompt?: string;
      maxCandidates?: number;
      topN?: number;
      threshold?: number;
      analysisMode?: "sequential" | "sheet";
      reasoningEffort?: "low" | "medium";
      constraints?: unknown;
      images?: { name?: string; dataUrl: string }[];
    }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    return context.json(await startVisualSelection({
      prompt: body.prompt.trim(),
      maxCandidates: body.maxCandidates,
      topN: body.topN,
      threshold: body.threshold,
      analysisMode: body.analysisMode,
      reasoningEffort: body.reasoningEffort,
      constraints: body.constraints,
      images: body.images,
    }, repository), 202);
  });
  app.get("/api/codex/visual-jobs/:id", (context) => {
    const job = getVisualSelection(context.req.param("id"), repository);
    return job ? context.json(job) : context.json({ error: "visual job not found" }, 404);
  });

  return app;
}
