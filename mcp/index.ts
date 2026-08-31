import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CatalogRepository } from "../server/repository";
import { filterSpecSchema, productPatchSchema, productSchema } from "../src/domain/catalog";
import { stableWorkspaceProductId } from "../src/domain/ids";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";
import { applyFilter } from "../src/domain/filter";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { projectCompactCached } from "../server/projection-cache";
import { buildContactSheet, buildProductPreview } from "./contact-sheet";
import { importPublicProductUrls } from "../server/public-product-import";
import { normalizePublicHttpsUrl } from "../server/public-network";
import { findSimilarProducts } from "../server/similarity";

const repository = new CatalogRepository();
const scopedVisualJobId = process.env.WARDROBE_VISUAL_JOB_ID;
const server = new McpServer(
  { name: "mosaic", version: "1.0.0" },
  {
    instructions: "Use Mosaic to inspect, visually assess, filter, organize, and enrich the user's private local visual-research workspaces. Work in the explicitly selected workspace. Prefer deterministic adapters or public structured data; use browser-extracted facts only when the user supplied them through the matching bounded tool. Never log in, checkout, solve CAPTCHAs, bypass a block, or purchase anything. Never invent prices, sizes, availability, images, or specifications. Prefer structured FilterSpec files over raw SQL.",
  },
);

function textResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], structuredContent: { result: value } };
}

function parseFilter(filterJson?: string) {
  return filterJson ? filterSpecSchema.parse(JSON.parse(filterJson)) : undefined;
}

const extractedAttributeSchema = z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
]);

const extractedItemSchema = z.object({
  url: z.string().url().max(2_000),
  source: z.string().trim().min(1).max(100).optional(),
  sourceId: z.string().trim().min(1).max(500).optional(),
  brand: z.string().trim().max(160).default("Unknown"),
  name: z.string().trim().min(1).max(300),
  description: z.string().max(5_000).default(""),
  price: z.number().nonnegative().nullable().default(null),
  originalPrice: z.number().nonnegative().nullable().default(null),
  currency: z.string().trim().length(3).default("CHF"),
  category: z.string().trim().max(160).default("Other"),
  color: z.string().trim().max(120).default("Unknown"),
  colorFamily: z.string().trim().max(120).default("unknown"),
  fit: z.string().trim().max(120).default("unknown"),
  materials: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  tags: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
  sizes: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  images: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
  attributes: z.record(z.string().max(160), extractedAttributeSchema).default({}),
  stockStatus: z.enum(["unknown", "in_stock", "out_of_stock"]).default("unknown"),
  availabilityCheckedAt: z.string().datetime().nullable().default(null),
  sizeAvailabilityKnown: z.boolean().default(false),
});

function workspaceOrThrow(workspaceId: string) {
  const workspace = repository.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

function reprojectWorkspace(workspaceId: string) {
  repository.replaceCoordinates(projectCompactCached(repository.listProducts({ workspaceId, limit: 10_000 })));
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
  server.registerTool("list_workspaces", {
    title: "List Mosaic workspaces",
    description: "List local visual-research workspaces and their domain profiles.",
    annotations: { readOnlyHint: true },
  }, async () => textResult(repository.listWorkspaces()));

  server.registerTool("get_workspace_ui_schema", {
    title: "Get workspace fields and facets",
    description: "Return committed or conservatively inferred fields and facet counts for one workspace.",
    inputSchema: { workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID) },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId }) => {
    workspaceOrThrow(workspaceId);
    const committed = repository.listFieldDefinitions(workspaceId);
    const fields = committed.length ? committed : repository.inferWorkspaceSchema(workspaceId);
    return textResult({
      workspace: repository.getWorkspace(workspaceId),
      inferred: committed.length === 0,
      fields,
      facets: repository.getWorkspaceFacets(workspaceId, fields.filter((field) => field.facetable).map((field) => field.key)),
    });
  });

  server.registerTool("list_collections", {
    title: "List workspace collections",
    description: "List reusable local selections and their ordered item memberships.",
    inputSchema: { workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID) },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId }) => textResult(repository.listCollections(workspaceId)));

  server.registerTool("create_collection", {
    title: "Create a local collection",
    description: "Create a bounded reusable selection in one workspace and optionally add known items.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2_000).default(""),
      itemIds: z.array(z.string().min(1)).max(160).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ workspaceId, name, description, itemIds }) => {
    let collection = repository.createCollection({ workspaceId, type: "manual", name, description });
    if (itemIds.length) collection = repository.addCollectionItems(collection.id, [...new Set(itemIds)].map((itemId) => ({ itemId })));
    return textResult(collection);
  });

  server.registerTool("add_items_to_collection", {
    title: "Add items to a local collection",
    description: "Add known items to an existing collection while preserving its current order and metadata.",
    inputSchema: {
      collectionId: z.string().min(1),
      itemIds: z.array(z.string().min(1)).min(1).max(160),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ collectionId, itemIds }) => textResult(
    repository.addCollectionItems(collectionId, [...new Set(itemIds)].map((itemId) => ({ itemId }))),
  ));

  server.registerTool("import_extracted_items", {
    title: "Import browser-extracted items",
    description: "Persist up to 50 factual public product records extracted through a user-supervised browser session. Unknown availability must remain unknown; this tool never browses by itself.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      items: z.array(extractedItemSchema).min(1).max(50),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, items }) => {
    workspaceOrThrow(workspaceId);
    const now = new Date().toISOString();
    const products = items.map((item) => {
      const safePageUrl = normalizePublicHttpsUrl(item.url);
      if (!safePageUrl) {
        throw new Error(`Only public HTTPS product pages are allowed: ${item.url}`);
      }
      const requested = new URL(safePageUrl);
      if (item.sizeAvailabilityKnown && (!item.availabilityCheckedAt || item.stockStatus === "unknown")) {
        throw new Error(`Verified sizes require a timestamp and explicit stock status: ${item.name}`);
      }
      const images = [...new Set(item.images.map((image) => {
        const safeUrl = normalizePublicHttpsUrl(image, requested);
        if (!safeUrl) throw new Error(`Only public HTTPS product images are allowed: ${image}`);
        return safeUrl;
      }))];
      const source = item.source?.trim() || `browser:${requested.hostname.toLocaleLowerCase()}`;
      const rawSourceId = item.sourceId?.trim() || `${requested.pathname}${requested.search}`;
      return productSchema.parse({
        id: stableWorkspaceProductId(workspaceId, source, rawSourceId),
        workspaceId,
        kind: "shop",
        source,
        sourceId: rawSourceId,
        url: requested.href, brand: item.brand, name: item.name, description: item.description,
        price: item.price, originalPrice: item.originalPrice, currency: item.currency.toLocaleUpperCase(),
        category: item.category, color: item.color, colorFamily: item.colorFamily, fit: item.fit,
        attributes: {
          ...item.attributes,
          sizeAvailabilityKnown: item.sizeAvailabilityKnown,
          extractedVia: "codex-browser",
          canonicalUrl: requested.href,
        },
        materials: item.materials, tags: item.tags,
        sizes: item.sizeAvailabilityKnown ? item.sizes : [], images,
        available: item.stockStatus !== "out_of_stock", stockStatus: item.stockStatus,
        stockCheckedAt: item.stockStatus === "unknown" ? null : item.availabilityCheckedAt,
        sizesCheckedAt: item.sizeAvailabilityKnown ? item.availabilityCheckedAt : null,
        priceCheckedAt: item.price === null ? null : item.availabilityCheckedAt,
        decision: "unseen", x: .5, y: .5, scores: {}, importedAt: now, updatedAt: now,
      });
    });
    repository.upsertCollectedProducts(products);
    reprojectWorkspace(workspaceId);
    return textResult({
      imported: products.length,
      products: products.map((product) => repository.getProduct(product.id, workspaceId) ?? product),
    });
  });

  server.registerTool("start_catalog_discovery", {
    title: "Start bounded adapter discovery",
    description: "Start one optimized local discovery job through an installed adapter. Requires the Mosaic local API to be running; use browser extraction for unsupported rendered sites.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      source: z.enum(["zalando-ch", "aboutyou-ch", "aliexpress"]),
      query: z.string().max(2_000).optional(),
      category: z.string().max(160).optional(),
      sizes: z.array(z.string().max(40)).max(20).default([]),
      minPrice: z.number().nonnegative().optional(),
      maxPrice: z.number().nonnegative().optional(),
      maxItems: z.number().int().min(1).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    workspaceOrThrow(input.workspaceId);
    const apiBase = process.env.MOSAIC_API_URL || "http://127.0.0.1:8788";
    const response = await fetch(`${apiBase}/api/discovery/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        intent: {
          source: input.source, query: input.query, category: input.category,
          sizes: input.sizes.length ? input.sizes : undefined, sizeMode: "any",
          minPrice: input.minPrice, maxPrice: input.maxPrice, maxItems: input.maxItems,
        },
      }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(`Mosaic discovery API returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return textResult(payload);
  });

  server.registerTool("catalog_stats", {
    title: "Catalog statistics",
    description: "Return catalog totals, sources, categories, saved decisions, and saved filters.",
    annotations: { readOnlyHint: true },
  }, async () => textResult(repository.stats()));

  server.registerTool("search_products", {
    title: "Search products",
    description: "Search products and references. filterJson accepts the complete nested FilterSpec DSL.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      query: z.string().optional(),
      filterJson: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      compact: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, query, filterJson, limit, compact }) => {
    const products = repository.listProducts({ workspaceId, search: query, filter: parseFilter(filterJson), limit });
    const result = compact ? compactProjection(projectProducts(products)) : products;
    return textResult(result);
  });

  server.registerTool("find_similar_products", {
    title: "Find visually similar products",
    description: "Find existing shop products near one to twelve catalog anchors using cached CLIP embeddings, with PCA fallback.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      productIds: z.array(z.string().min(1)).min(1).max(12),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, productIds, limit }) => textResult(await findSimilarProducts({
    productIds,
    limit,
    constraints: { workspaceId },
  }, repository)));

  server.registerTool("import_public_product_links", {
    title: "Import public product links",
    description: "Import up to twelve user-supplied public HTTPS product pages exposing Product JSON-LD. Never logs in or bypasses a block.",
    inputSchema: {
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      urls: z.array(z.string().url().max(2_000)).min(1).max(24),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ workspaceId, urls }) => {
    workspaceOrThrow(workspaceId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const result = await importPublicProductUrls(urls, repository, controller.signal, { workspaceId });
      if (result.products.length) reprojectWorkspace(workspaceId);
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
    workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
    query: z.string().optional(),
    filterJson: z.string().optional(),
    limit: z.number().int().min(1).max(36).default(24),
  },
  annotations: { readOnlyHint: true },
}, async ({ workspaceId, query, filterJson, limit }) => {
  if (scopedVisualJobId) throw new Error("Use build_visual_candidate_sheet inside a scoped visual job.");
  const products = repository.listProducts({ workspaceId, search: query, filter: parseFilter(filterJson), limit });
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

const visualAssessmentInputSchema = {
  jobId: z.string().min(1),
  productId: z.string().min(1),
  score: z.number().min(0).max(1),
  rejected: z.boolean().default(false),
  reason: z.string().min(1).max(300),
  signals: z.array(z.string().max(80)).max(6).default([]),
};

if (scopedVisualJobId) server.registerTool("propose_visual_assessment", {
  title: "Propose one visual assessment",
  description: "After inspecting exactly one frozen candidate image, return its 0–1 score and rationale. This tool is read-only; the scoped local runner validates and persists successful proposals.",
  inputSchema: visualAssessmentInputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  assertVisualJobScope(input.jobId);
  if (!repository.isVisualJobCandidate(input.jobId, input.productId)) {
    throw new Error(`Product ${input.productId} is not an allowed candidate for visual job ${input.jobId}.`);
  }
  return textResult(input);
});
else server.registerTool("record_visual_assessment", {
  title: "Record one visual assessment",
  description: "Record a validated 0–1 visual assessment in an interactive Mosaic session.",
  inputSchema: {
    ...visualAssessmentInputSchema,
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async (input) => {
  assertVisualJobScope(input.jobId);
  return textResult(repository.recordVisualAssessment(input));
});

server.registerTool("save_filter", {
  title: "Save an editable filter",
  description: "Validate and save a nested FilterSpec generated from the user's natural-language request.",
  inputSchema: {
    workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
    filterJson: z.string().min(2),
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async ({ workspaceId, filterJson }) => {
  if (scopedVisualJobId) throw new Error("Saving arbitrary filters is unavailable inside a scoped visual job.");
  return textResult(repository.saveFilter(filterSpecSchema.parse(JSON.parse(filterJson)), workspaceId));
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
