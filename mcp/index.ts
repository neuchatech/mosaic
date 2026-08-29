import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CatalogRepository } from "../server/repository";
import { filterSpecSchema, productPatchSchema } from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { projectCompactCached } from "../server/projection-cache";
import { buildContactSheet, buildProductPreview } from "./contact-sheet";
import { importPublicProductUrls } from "../server/public-product-import";
import { findSimilarProducts } from "../server/similarity";

const repository = new CatalogRepository();
const scopedVisualJobId = process.env.WARDROBE_VISUAL_JOB_ID;
const server = new McpServer(
  { name: "wardrobe-atlas", version: "0.1.0" },
  {
    instructions: "Use Wardrobe Atlas to inspect, visually assess, filter, and annotate the user's private clothing catalog. You may import a bounded list of public product URLs explicitly supplied by the user. Never trigger broad collection, login, checkout, CAPTCHA handling, bypasses, or purchases. Prefer structured FilterSpec files over raw SQL. Reproject a filtered subset before presenting it. References are style anchors, not purchasable products.",
  },
);

function textResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], structuredContent: { result: value } };
}

function parseFilter(filterJson?: string) {
  return filterJson ? filterSpecSchema.parse(JSON.parse(filterJson)) : undefined;
}

function assertVisualJobScope(jobId: string) {
  if (scopedVisualJobId && scopedVisualJobId !== jobId) throw new Error(`This MCP process is scoped to visual job ${scopedVisualJobId}.`);
}

function visualContextIds(jobId: string): string[] {
  assertVisualJobScope(jobId);
  const job = repository.getVisualJob(jobId);
  if (!job) throw new Error(`Unknown visual job: ${jobId}`);
  const ids = job.constraints.contextIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function visualContextProducts(jobId: string) {
  return visualContextIds(jobId).map((id) => repository.getProduct(id)).filter(Boolean);
}

function visualCandidates(jobId: string, options: { query?: string; filterJson?: string; offset?: number; limit?: number } = {}) {
  assertVisualJobScope(jobId);
  const job = repository.getVisualJob(jobId);
  if (!job) throw new Error(`Unknown visual job: ${jobId}`);
  let products = repository.listVisualJobCandidates(jobId);
  if (options.query?.trim()) {
    const query = options.query.trim().toLocaleLowerCase("fr-CH");
    products = products.filter((product) => [product.brand, product.name, product.description, ...product.tags]
      .join(" ").toLocaleLowerCase("fr-CH").includes(query));
  }
  const filter = parseFilter(options.filterJson);
  if (filter) products = applyFilter(products, { ...filter, limit: 5000 });
  const offset = Math.max(0, options.offset ?? 0);
  return products.slice(offset, offset + Math.min(Math.max(options.limit ?? 100, 1), 500));
}

// A scoped Vision subprocess must not be able to enumerate or search outside
// the immutable candidate membership frozen for its job.
if (!scopedVisualJobId) {
  server.registerTool("catalog_stats", {
    title: "Catalog statistics",
    description: "Return catalog totals, sources, categories, saved decisions, and saved filters.",
    annotations: { readOnlyHint: true },
  }, async () => textResult(repository.stats()));

  server.registerTool("search_products", {
    title: "Search products",
    description: "Search products and references. filterJson accepts the complete nested FilterSpec DSL.",
    inputSchema: {
      query: z.string().optional(),
      filterJson: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      compact: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, filterJson, limit, compact }) => {
    const products = repository.listProducts({ search: query, filter: parseFilter(filterJson), limit });
    const result = compact ? compactProjection(projectProducts(products)) : products;
    return textResult(result);
  });

  server.registerTool("find_similar_products", {
    title: "Find visually similar products",
    description: "Find existing shop products near one to twelve catalog anchors using cached CLIP embeddings, with PCA fallback.",
    inputSchema: {
      productIds: z.array(z.string().min(1)).min(1).max(12),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true },
  }, async ({ productIds, limit }) => textResult(await findSimilarProducts({ productIds, limit }, repository)));

  server.registerTool("import_public_product_links", {
    title: "Import public product links",
    description: "Import up to twelve user-supplied public HTTPS product pages exposing Product JSON-LD. Never logs in or bypasses a block.",
    inputSchema: { urls: z.array(z.string().url().max(2_000)).min(1).max(12) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ urls }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const result = await importPublicProductUrls(urls, repository, controller.signal);
      if (result.products.length) repository.replaceCoordinates(projectCompactCached(repository.listProducts({ limit: 10_000 })));
      return textResult(result);
    } finally { clearTimeout(timeout); }
  });
}

server.registerTool("get_visual_job_context", {
  title: "Get visual job context",
  description: "Return one visual job's immutable hard constraints, candidate count, progress, and reference-image paths.",
  inputSchema: { jobId: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, async ({ jobId }) => {
  assertVisualJobScope(jobId);
  const job = repository.getVisualJob(jobId);
  if (!job) throw new Error(`Unknown visual job: ${jobId}`);
  const styleContext = visualContextProducts(jobId).map((product) => ({
    id: product!.id,
    kind: product!.kind,
    decision: product!.decision,
    brand: product!.brand,
    name: product!.name,
    category: product!.category,
    color: product!.color,
    fit: product!.fit,
    materials: product!.materials,
  }));
  return textResult({ ...job, styleContext });
});

server.registerTool("list_visual_candidates", {
  title: "List frozen visual candidates",
  description: "Search only inside the immutable, hard-filtered candidate set for one visual job.",
  inputSchema: {
    jobId: z.string().min(1),
    query: z.string().optional(),
    filterJson: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true },
}, async ({ jobId, query, filterJson, offset, limit }) => textResult(
  projectCompactCached(visualCandidates(jobId, { query, filterJson, offset, limit })),
));

server.registerTool("build_visual_candidate_sheet", {
  title: "Build a hard-filtered visual candidate sheet",
  description: "Create a contact sheet using only frozen candidates from one visual job.",
  inputSchema: {
    jobId: z.string().min(1),
    query: z.string().optional(),
    filterJson: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(36).default(12),
  },
  annotations: { readOnlyHint: true },
}, async ({ jobId, query, filterJson, offset, limit }) => {
  const products = visualCandidates(jobId, { query, filterJson, offset, limit });
  const sheet = await buildContactSheet(products);
  return {
    content: [
      { type: "text", text: JSON.stringify({ jobId, path: sheet.path, products: products.map(({ id, brand, name }) => ({ id, brand, name })) }, null, 2) },
      { type: "image", data: sheet.buffer.toString("base64"), mimeType: "image/jpeg" },
    ],
  };
});

server.registerTool("build_contact_sheet", {
  title: "Build visual product sheet",
  description: "Create and return a numbered image grid for vision review. Use several batches instead of exceeding 36 products.",
  inputSchema: {
    query: z.string().optional(),
    filterJson: z.string().optional(),
    limit: z.number().int().min(1).max(36).default(24),
  },
  annotations: { readOnlyHint: true },
}, async ({ query, filterJson, limit }) => {
  if (scopedVisualJobId) throw new Error("Use build_visual_candidate_sheet inside a scoped visual job.");
  const products = repository.listProducts({ search: query, filter: parseFilter(filterJson), limit });
  const sheet = await buildContactSheet(products);
  return {
    content: [
      { type: "text", text: JSON.stringify({ path: sheet.path, products: products.map(({ id, brand, name, url }) => ({ id, brand, name, url })) }, null, 2) },
      { type: "image", data: sheet.buffer.toString("base64"), mimeType: "image/jpeg" },
    ],
  };
});

server.registerTool("inspect_product_image", {
  title: "Inspect one product image",
  description: "Return one catalog item's metadata and its first image. Use this for sequential agentic visual review, one product at a time.",
  inputSchema: { id: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  if (scopedVisualJobId) throw new Error("Use inspect_visual_candidate or inspect_visual_context inside a scoped visual job.");
  const product = repository.getProduct(id);
  if (!product) throw new Error(`Unknown product: ${id}`);
  const preview = await buildProductPreview(product);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          id: product.id,
          kind: product.kind,
          brand: product.brand,
          name: product.name,
          category: product.category,
          color: product.color,
          fit: product.fit,
          materials: product.materials,
          price: product.price,
          url: product.url,
        }, null, 2),
      },
      { type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" },
    ],
  };
});

server.registerTool("inspect_visual_candidate", {
  title: "Inspect one frozen visual candidate",
  description: "Return one candidate's metadata and image only after validating its membership in the visual job's hard-filtered set.",
  inputSchema: { jobId: z.string().min(1), productId: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, async ({ jobId, productId }) => {
  assertVisualJobScope(jobId);
  if (!repository.isVisualJobCandidate(jobId, productId)) {
    throw new Error(`Product ${productId} is not an allowed candidate for visual job ${jobId}.`);
  }
  const product = repository.getProduct(productId)!;
  const preview = await buildProductPreview(product);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          id: product.id,
          brand: product.brand,
          name: product.name,
          category: product.category,
          color: product.color,
          fit: product.fit,
          materials: product.materials,
          price: product.price,
          sizes: product.sizes,
          stockStatus: product.stockStatus,
          stockCheckedAt: product.stockCheckedAt,
          sizesCheckedAt: product.sizesCheckedAt,
          decision: product.decision,
          returns: {
            label: product.attributes.returnsLabel ?? null,
            days: product.attributes.returnsWindowDays ?? null,
          },
          url: product.url,
        }, null, 2),
      },
      { type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" },
    ],
  };
});

server.registerTool("inspect_visual_context", {
  title: "Inspect one frozen wardrobe or reference anchor",
  description: "Return one saved, owned, or reference garment from the visual job's frozen style context. Context anchors guide judgment but must never be scored as candidates.",
  inputSchema: { jobId: z.string().min(1), productId: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, async ({ jobId, productId }) => {
  assertVisualJobScope(jobId);
  if (!visualContextIds(jobId).includes(productId)) throw new Error(`Product ${productId} is not a frozen context anchor for visual job ${jobId}.`);
  const product = repository.getProduct(productId)!;
  const preview = await buildProductPreview(product);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          id: product.id,
          kind: product.kind,
          decision: product.decision,
          brand: product.brand,
          name: product.name,
          category: product.category,
          color: product.color,
          fit: product.fit,
          materials: product.materials,
          tags: product.tags,
        }, null, 2),
      },
      { type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" },
    ],
  };
});

server.registerTool("record_visual_assessment", {
  title: "Record one visual assessment",
  description: "After inspecting exactly one product image, record its 0–1 relevance score and concise rationale. This immediately streams progress to the local UI.",
  inputSchema: {
    jobId: z.string().min(1),
    productId: z.string().min(1),
    score: z.number().min(0).max(1),
    rejected: z.boolean().default(false),
    reason: z.string().min(1).max(300),
    signals: z.array(z.string().max(80)).max(6).default([]),
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async (input) => {
  assertVisualJobScope(input.jobId);
  return textResult(repository.recordVisualAssessment(input));
});

server.registerTool("save_filter", {
  title: "Save an editable filter",
  description: "Validate and save a nested FilterSpec generated from the user's natural-language request.",
  inputSchema: { filterJson: z.string().min(2) },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async ({ filterJson }) => {
  if (scopedVisualJobId) throw new Error("Saving arbitrary filters is unavailable inside a scoped visual job.");
  return textResult(repository.saveFilter(filterSpecSchema.parse(JSON.parse(filterJson))));
});

server.registerTool("annotate_products", {
  title: "Annotate products after review",
  description: "Add decisions, tags, arbitrary attributes, or 0–100 visual scores to selected product IDs.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(500),
    patchJson: z.string().min(2),
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async ({ ids, patchJson }) => {
  if (scopedVisualJobId) throw new Error("Arbitrary catalog annotation is unavailable inside a scoped visual job.");
  const patch = productPatchSchema.parse(JSON.parse(patchJson));
  return textResult({ updated: repository.patchProducts(ids, patch) });
});

await server.connect(new StdioServerTransport());
