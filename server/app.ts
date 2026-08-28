import { Hono } from "hono";
import { cors } from "hono/cors";
import { filterSpecSchema, productPatchSchema, productSchema } from "../src/domain/catalog";
import { stableProductId } from "../src/domain/ids";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { CatalogRepository } from "./repository";
import { createFilterWithCodex } from "./codex-bridge";
import { getVisualSelection, startVisualSelection } from "./visual-selection";

export function createApp(repository = new CatalogRepository()) {
  const app = new Hono();
  app.use("/api/*", cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));

  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/api/stats", (context) => context.json(repository.stats()));
  app.get("/api/products", (context) => {
    const search = context.req.query("search");
    const limit = Number(context.req.query("limit") ?? 1000);
    return context.json(repository.listProducts({ search, limit }));
  });
  app.post("/api/products/import", async (context) => {
    const body = await context.req.json();
    const products = productSchema.array().parse(body.products ?? body);
    return context.json({ imported: repository.upsertProducts(products) }, 201);
  });
  app.post("/api/query", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    const products = repository.listProducts({ filter, limit: filter.limit });
    return context.json(compactProjection(projectProducts(products)));
  });
  app.post("/api/references", async (context) => {
    const input = await context.req.json<{
      name: string;
      images: string[];
      description?: string;
      category?: string;
      color?: string;
      colorFamily?: string;
      fit?: string;
      tags?: string[];
      attributes?: Record<string, string | number | boolean | string[] | null>;
    }>();
    const sourceId = crypto.randomUUID();
    const now = new Date().toISOString();
    const reference = productSchema.parse({
      id: stableProductId("reference", sourceId),
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
      images: input.images,
      available: true,
      decision: "saved",
      x: .5,
      y: .5,
      scores: {},
      importedAt: now,
      updatedAt: now,
    });
    repository.upsertProducts([reference]);
    return context.json(reference, 201);
  });
  app.patch("/api/products/:id", async (context) => {
    const patch = productPatchSchema.parse(await context.req.json());
    const updated = repository.patchProducts([context.req.param("id")], patch);
    return context.json({ updated });
  });
  app.get("/api/filters", (context) => context.json(repository.listFilters()));
  app.post("/api/filters", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    return context.json(repository.saveFilter(filter), 201);
  });
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
  app.post("/api/codex/visual-select", async (context) => {
    const body = await context.req.json<{
      prompt?: string;
      maxCandidates?: number;
      topN?: number;
      threshold?: number;
      analysisMode?: "sequential" | "sheet";
      images?: { name?: string; dataUrl: string }[];
    }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    return context.json(await startVisualSelection({
      prompt: body.prompt.trim(),
      maxCandidates: body.maxCandidates,
      topN: body.topN,
      threshold: body.threshold,
      analysisMode: body.analysisMode,
      images: body.images,
    }, repository), 202);
  });
  app.get("/api/codex/visual-jobs/:id", (context) => {
    const job = getVisualSelection(context.req.param("id"), repository);
    return job ? context.json(job) : context.json({ error: "visual job not found" }, 404);
  });

  return app;
}
