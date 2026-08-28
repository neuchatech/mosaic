import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CatalogRepository } from "../server/repository";
import { filterSpecSchema, productPatchSchema } from "../src/domain/catalog";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { buildContactSheet, buildProductPreview } from "./contact-sheet";

const repository = new CatalogRepository();
const server = new McpServer(
  { name: "wardrobe-atlas", version: "0.1.0" },
  {
    instructions: "Use Wardrobe Atlas to inspect, visually assess, filter, and annotate the user's private clothing catalog. Never trigger collection, login, checkout, CAPTCHA handling, or purchases. Prefer structured FilterSpec files over raw SQL. Reproject a filtered subset before presenting it. References are style anchors, not purchasable products.",
  },
);

function textResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], structuredContent: { result: value } };
}

function parseFilter(filterJson?: string) {
  return filterJson ? filterSpecSchema.parse(JSON.parse(filterJson)) : undefined;
}

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
}, async (input) => textResult(repository.recordVisualAssessment(input)));

server.registerTool("save_filter", {
  title: "Save an editable filter",
  description: "Validate and save a nested FilterSpec generated from the user's natural-language request.",
  inputSchema: { filterJson: z.string().min(2) },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async ({ filterJson }) => textResult(repository.saveFilter(filterSpecSchema.parse(JSON.parse(filterJson)))));

server.registerTool("annotate_products", {
  title: "Annotate products after review",
  description: "Add decisions, tags, arbitrary attributes, or 0–100 visual scores to selected product IDs.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(500),
    patchJson: z.string().min(2),
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, async ({ ids, patchJson }) => {
  const patch = productPatchSchema.parse(JSON.parse(patchJson));
  return textResult({ updated: repository.patchProducts(ids, patch) });
});

await server.connect(new StdioServerTransport());
