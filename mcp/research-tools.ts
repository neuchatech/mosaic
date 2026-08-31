import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { discoveryAdapterFor, listAdapters } from "../collector/registry";
import type { DiscoverySource } from "../collector/types";
import { importPublicProductUrls } from "../server/public-product-import";
import { normalizePublicHttpsUrl } from "../server/public-network";
import { projectCompactCached } from "../server/projection-cache";
import type { CatalogRepository } from "../server/repository";
import { installedResearchSources } from "../server/research-context";
import { findSimilarProducts } from "../server/similarity";
import { rankWorkspaceByVisualReferences } from "../server/visual-selection";
import {
  filterClauseSchema,
  filterSpecSchema,
  productPatchSchema,
  productSchema,
  type FilterSpec,
  type Product,
} from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";
import { stableWorkspaceProductId } from "../src/domain/ids";
import {
  DEFAULT_RESEARCH_BUDGET,
  researchBudgetSchema,
  type ResearchBudget,
  type ResearchRun,
} from "../src/domain/research";
import { buildContactSheet, buildProductPreview } from "./contact-sheet";

const MAX_QUERY_ITEMS = 200;
const MAX_SAMPLE_ITEMS = 100;
const MAX_CONTACT_SHEET_ITEMS = 36;
const MAX_BROWSER_OBSERVATIONS = 50;

export const researchSampleStrategySchema = z.enum([
  "diverse",
  "recent",
  "outliers",
  "uncertain",
  "random",
  "cluster",
]);

export type ResearchSampleStrategy = z.infer<typeof researchSampleStrategySchema>;

export type ResearchScope = {
  runId: string;
  workspaceId: string;
};

type BudgetCost = Partial<{
  itemsRead: number;
  imageInspections: number;
  acquisitionJobs: number;
  acquiredItems: number;
  collectionWrites: number;
}>;

type BudgetCounters = {
  toolCalls: number;
  itemsRead: number;
  imageInspections: number;
  acquisitionJobs: number;
  acquiredItems: number;
  collectionWrites: number;
};

const zeroCounters = (): BudgetCounters => ({
  toolCalls: 0,
  itemsRead: 0,
  imageInspections: 0,
  acquisitionJobs: 0,
  acquiredItems: 0,
  collectionWrites: 0,
});

export function researchScopeFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ResearchScope | null {
  const runId = environment.MOSAIC_RESEARCH_RUN_ID?.trim() ?? "";
  const workspaceId = environment.MOSAIC_RESEARCH_WORKSPACE_ID?.trim() ?? "";
  if (!runId && !workspaceId) return null;
  if (!runId || !workspaceId) {
    throw new Error("MOSAIC_RESEARCH_RUN_ID and MOSAIC_RESEARCH_WORKSPACE_ID must be set together.");
  }
  return {
    runId: z.string().min(1).max(256).parse(runId),
    workspaceId: z.string().min(1).max(128).parse(workspaceId),
  };
}

export function researchBudgetFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ResearchBudget {
  const raw = environment.MOSAIC_RESEARCH_BUDGET_JSON?.trim();
  if (!raw) return researchBudgetSchema.parse(DEFAULT_RESEARCH_BUDGET);
  try {
    return researchBudgetSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid MOSAIC_RESEARCH_BUDGET_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class ResearchBudgetMeter {
  private readonly counters = zeroCounters();

  constructor(readonly budget: ResearchBudget) {}

  consume(cost: BudgetCost = {}): void {
    const next: BudgetCounters = {
      toolCalls: this.counters.toolCalls + 1,
      itemsRead: this.counters.itemsRead + (cost.itemsRead ?? 0),
      imageInspections: this.counters.imageInspections + (cost.imageInspections ?? 0),
      acquisitionJobs: this.counters.acquisitionJobs + (cost.acquisitionJobs ?? 0),
      acquiredItems: this.counters.acquiredItems + (cost.acquiredItems ?? 0),
      collectionWrites: this.counters.collectionWrites + (cost.collectionWrites ?? 0),
    };
    const checks: Array<[keyof BudgetCounters, number]> = [
      ["toolCalls", this.budget.maxToolCalls],
      ["itemsRead", this.budget.maxItemsRead],
      ["imageInspections", this.budget.maxImageInspections],
      ["acquisitionJobs", this.budget.maxAcquisitionJobs],
      ["acquiredItems", this.budget.maxAcquiredItems],
      ["collectionWrites", this.budget.maxCollectionWrites],
    ];
    const exceeded = checks.find(([key, maximum]) => next[key] > maximum);
    if (exceeded) {
      const [key, maximum] = exceeded;
      throw new Error(`Research budget exhausted: ${key} would be ${next[key]}, maximum ${maximum}. Return partial results or ask for a larger budget.`);
    }
    Object.assign(this.counters, next);
  }

  consumeWithoutTool(cost: BudgetCost): void {
    this.counters.toolCalls -= 1;
    try {
      this.consume(cost);
    } catch (error) {
      this.counters.toolCalls += 1;
      throw error;
    }
  }

  snapshot() {
    return {
      used: { ...this.counters },
      remaining: {
        toolCalls: this.budget.maxToolCalls - this.counters.toolCalls,
        itemsRead: this.budget.maxItemsRead - this.counters.itemsRead,
        imageInspections: this.budget.maxImageInspections - this.counters.imageInspections,
        acquisitionJobs: this.budget.maxAcquisitionJobs - this.counters.acquisitionJobs,
        acquiredItems: this.budget.maxAcquiredItems - this.counters.acquiredItems,
        collectionWrites: this.budget.maxCollectionWrites - this.counters.collectionWrites,
      },
    };
  }
}

function mostRestrictiveBudget(left: ResearchBudget, right: ResearchBudget): ResearchBudget {
  return researchBudgetSchema.parse({
    maxDurationMs: Math.min(left.maxDurationMs, right.maxDurationMs),
    maxToolCalls: Math.min(left.maxToolCalls, right.maxToolCalls),
    maxItemsRead: Math.min(left.maxItemsRead, right.maxItemsRead),
    maxImageInspections: Math.min(left.maxImageInspections, right.maxImageInspections),
    maxAcquisitionJobs: Math.min(left.maxAcquisitionJobs, right.maxAcquisitionJobs),
    maxAcquiredItems: Math.min(left.maxAcquiredItems, right.maxAcquiredItems),
    maxCollectionWrites: Math.min(left.maxCollectionWrites, right.maxCollectionWrites),
  });
}

const extractedAttributeSchema = z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
]);

const browserObservationSchema = z.object({
  url: z.string().url().max(2_000),
  source: z.string().trim().min(1).max(100).optional(),
  sourceId: z.string().trim().min(1).max(500).optional(),
  brand: z.string().trim().max(160).default("Unknown"),
  name: z.string().trim().min(1).max(300),
  description: z.string().max(5_000).default(""),
  price: z.number().nonnegative().nullable().default(null),
  originalPrice: z.number().nonnegative().nullable().default(null),
  currency: z.string().trim().length(3).default("XXX"),
  category: z.string().trim().max(160).default("Other"),
  color: z.string().trim().max(120).default("Unknown"),
  colorFamily: z.string().trim().max(120).default("unknown"),
  fit: z.string().trim().max(120).default("unknown"),
  materials: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  tags: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
  availableVariantLabels: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  images: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
  attributes: z.record(z.string().max(160), extractedAttributeSchema).default({}),
  stockStatus: z.enum(["unknown", "in_stock", "out_of_stock"]).default("unknown"),
  observedAt: z.string().datetime().nullable().default(null),
  variantAvailabilityKnown: z.boolean().default(false),
});

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function workspaceOrThrow(repository: CatalogRepository, workspaceId: string) {
  const workspace = repository.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown research workspace: ${workspaceId}`);
  return workspace;
}

function scopedProductOrThrow(repository: CatalogRepository, scope: ResearchScope, id: string): Product {
  const product = repository.getProduct(id, scope.workspaceId);
  if (!product) throw new Error(`Unknown item in this research workspace: ${id}`);
  return product;
}

function hardConstraintFilter(run: ResearchRun): FilterSpec | undefined {
  const clauses = run.request.constraints
    .filter((constraint) => constraint.strength === "hard")
    .map((constraint) => {
      const parsed = filterClauseSchema.safeParse({
        type: "clause",
        field: constraint.field,
        operator: constraint.operator,
        value: constraint.value,
      });
      if (!parsed.success) {
        throw new Error(`Hard constraint ${constraint.field} cannot be enforced by the FilterSpec engine: ${parsed.error.message}`);
      }
      return parsed.data;
    });
  if (clauses.length === 0) return undefined;
  return filterSpecSchema.parse({
    id: `research-hard:${run.id}`,
    name: "Research hard constraints",
    description: "Automatically enforced by workspace-scoped research tools.",
    where: { type: "group", conjunction: "and", children: clauses },
    limit: 5_000,
  });
}

function mergeWithHardConstraints(
  requested: FilterSpec | undefined,
  hard: FilterSpec | undefined,
): FilterSpec | undefined {
  if (!hard) return requested;
  if (!requested) return hard;
  return filterSpecSchema.parse({
    ...requested,
    id: `${requested.id}:research-hard`,
    name: requested.name,
    description: requested.description,
    where: {
      type: "group",
      conjunction: "and",
      children: [hard.where, requested.where],
    },
    limit: Math.min(requested.limit, hard.limit),
  });
}

function eligibleProducts(products: Product[], hard: FilterSpec | undefined): Product[] {
  return hard ? applyFilter(products, { ...hard, limit: 5_000 }) : products;
}

function reprojectWorkspace(repository: CatalogRepository, workspaceId: string): void {
  repository.replaceCoordinates(projectCompactCached(repository.listProducts({ workspaceId, limit: 10_000 })));
}

function conciseItem(product: Product) {
  return {
    id: product.id,
    kind: product.kind,
    source: product.source,
    sourceId: product.sourceId,
    url: product.url,
    brand: product.brand,
    name: product.name,
    description: product.description.slice(0, 1_500),
    price: product.price,
    originalPrice: product.originalPrice,
    currency: product.currency,
    category: product.category,
    color: product.color,
    colorFamily: product.colorFamily,
    fit: product.fit,
    attributes: product.attributes,
    materials: product.materials,
    tags: product.tags,
    annotations: product.annotations ?? {},
    sizes: product.sizes,
    images: product.images.slice(0, 6),
    imageCount: product.images.length,
    available: product.available,
    stockStatus: product.stockStatus ?? "unknown",
    stockCheckedAt: product.stockCheckedAt ?? null,
    priceCheckedAt: product.priceCheckedAt ?? null,
    sizesCheckedAt: product.sizesCheckedAt ?? null,
    decision: product.decision,
    coordinates: { x: product.x, y: product.y },
    embeddingRevision: product.embeddingRevision ?? null,
    scores: product.scores,
    importedAt: product.importedAt,
    updatedAt: product.updatedAt,
  };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function workspaceInventory(products: Product[]) {
  const priced = products.filter((product) => product.price !== null);
  return {
    total: products.length,
    kinds: countBy(products.map((product) => product.kind)),
    sources: countBy(products.map((product) => product.source)),
    categories: countBy(products.map((product) => product.category)),
    decisions: countBy(products.map((product) => product.decision)),
    withImages: products.filter((product) => product.images.length > 0).length,
    withEmbeddings: products.filter((product) => Boolean(product.embeddingRevision)).length,
    priced: priced.length,
    priceRange: priced.length > 0
      ? { min: Math.min(...priced.map((product) => product.price!)), max: Math.max(...priced.map((product) => product.price!)) }
      : null,
  };
}

export function sourceCapabilities() {
  return {
    sources: installedResearchSources(),
    genericPublicItemImport: {
      available: true,
      requirement: "A public HTTPS item page with usable structured item data",
      maxUrlsPerCall: 24,
    },
    browserObservationImport: {
      available: true,
      requirement: "Factual observations supplied by a separately configured, user-visible browser capability",
      maxItemsPerCall: MAX_BROWSER_OBSERVATIONS,
    },
  };
}

function stableRandom(seed: string, id: string): number {
  const digest = createHash("sha256").update(`${seed}\u0000${id}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function normalizedCoordinates(products: Product[]): Map<string, { x: number; y: number }> {
  if (products.length === 0) return new Map();
  const xs = products.map((product) => product.x);
  const ys = products.map((product) => product.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, Number.EPSILON);
  const spanY = Math.max(maxY - minY, Number.EPSILON);
  return new Map(products.map((product) => [product.id, {
    x: (product.x - minX) / spanX,
    y: (product.y - minY) / spanY,
  }]));
}

function categoricalNovelty(product: Product, selected: Product[]): number {
  if (selected.length === 0) return 1;
  const sourceNovel = selected.some((item) => item.source === product.source) ? 0 : 1;
  const categoryNovel = selected.some((item) => item.category === product.category) ? 0 : 1;
  const kindNovel = selected.some((item) => item.kind === product.kind) ? 0 : 1;
  return sourceNovel * 0.35 + categoryNovel * 0.45 + kindNovel * 0.2;
}

function diverseSample(products: Product[], limit: number, seed: string): Product[] {
  if (products.length <= limit) return [...products];
  const coordinates = normalizedCoordinates(products);
  const centroid = products.reduce((point, product) => {
    const coordinate = coordinates.get(product.id)!;
    point.x += coordinate.x / products.length;
    point.y += coordinate.y / products.length;
    return point;
  }, { x: 0, y: 0 });
  const first = [...products].sort((left, right) => {
    const a = coordinates.get(left.id)!;
    const b = coordinates.get(right.id)!;
    const leftDistance = Math.hypot(a.x - centroid.x, a.y - centroid.y);
    const rightDistance = Math.hypot(b.x - centroid.x, b.y - centroid.y);
    return rightDistance - leftDistance || stableRandom(seed, right.id) - stableRandom(seed, left.id);
  })[0]!;
  const selected = [first];
  const remaining = new Map(products.filter((product) => product.id !== first.id).map((product) => [product.id, product]));
  while (selected.length < limit && remaining.size > 0) {
    let best: Product | null = null;
    let bestScore = -1;
    for (const product of remaining.values()) {
      const point = coordinates.get(product.id)!;
      const distance = Math.min(...selected.map((candidate) => {
        const selectedPoint = coordinates.get(candidate.id)!;
        return Math.hypot(point.x - selectedPoint.x, point.y - selectedPoint.y);
      }));
      const score = distance + categoricalNovelty(product, selected) * 0.28 + stableRandom(seed, product.id) * 0.001;
      if (score > bestScore) {
        best = product;
        bestScore = score;
      }
    }
    if (!best) break;
    selected.push(best);
    remaining.delete(best.id);
  }
  return selected;
}

function uncertaintyScore(product: Product): number {
  const missing = [
    !product.images.length,
    !product.description.trim(),
    product.price === null,
    !Object.keys(product.attributes).length,
    !product.tags.length,
    !product.embeddingRevision,
    (product.stockStatus ?? "unknown") === "unknown",
  ].filter(Boolean).length;
  const lowEvidence = Object.keys(product.scores).length === 0 ? 0.5 : 0;
  return missing + lowEvidence;
}

type ClusteredProducts = {
  products: Product[];
  clusters: Array<{ key: string; count: number; center: { x: number; y: number } }>;
};

function clusterSample(products: Product[], limit: number, requestedKey?: string): ClusteredProducts {
  if (products.length === 0) return { products: [], clusters: [] };
  const coordinates = normalizedCoordinates(products);
  const targetClusters = Math.min(25, Math.max(1, Math.round(Math.sqrt(products.length / 2))));
  const side = Math.ceil(Math.sqrt(targetClusters));
  const buckets = new Map<string, Product[]>();
  for (const product of products) {
    const point = coordinates.get(product.id)!;
    const column = Math.min(side - 1, Math.floor(point.x * side));
    const row = Math.min(side - 1, Math.floor(point.y * side));
    const key = `${column}:${row}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(product);
    buckets.set(key, bucket);
  }
  const entries = [...buckets.entries()].sort(([leftKey, left], [rightKey, right]) => (
    right.length - left.length || leftKey.localeCompare(rightKey)
  ));
  const clusters = entries.map(([key, items]) => {
    const points = items.map((item) => coordinates.get(item.id)!);
    return {
      key,
      count: items.length,
      center: {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      },
    };
  });
  const selectedEntries = requestedKey ? entries.filter(([key]) => key === requestedKey) : entries;
  if (requestedKey && selectedEntries.length === 0) {
    throw new Error(`Unknown cluster key ${requestedKey}. Available keys: ${clusters.map(({ key }) => key).join(", ")}`);
  }
  const orderedBuckets = selectedEntries.map(([key, items]) => {
    const center = clusters.find((cluster) => cluster.key === key)!.center;
    return [...items].sort((left, right) => {
      const a = coordinates.get(left.id)!;
      const b = coordinates.get(right.id)!;
      return Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y);
    });
  });
  const selected: Product[] = [];
  for (let depth = 0; selected.length < limit; depth += 1) {
    let found = false;
    for (const bucket of orderedBuckets) {
      const item = bucket[depth];
      if (!item) continue;
      selected.push(item);
      found = true;
      if (selected.length >= limit) break;
    }
    if (!found) break;
  }
  return { products: selected, clusters };
}

export function sampleWorkspaceProducts(input: {
  products: Product[];
  strategy: ResearchSampleStrategy;
  limit: number;
  seed: string;
  clusterKey?: string;
}): ClusteredProducts {
  const { products, strategy, limit, seed, clusterKey } = input;
  if (strategy === "cluster") return clusterSample(products, limit, clusterKey);
  if (products.length <= limit) return { products: [...products], clusters: [] };
  if (strategy === "diverse") return { products: diverseSample(products, limit, seed), clusters: [] };
  if (strategy === "recent") {
    return { products: [...products].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit), clusters: [] };
  }
  if (strategy === "uncertain") {
    return { products: [...products].sort((a, b) => uncertaintyScore(b) - uncertaintyScore(a)
      || a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit), clusters: [] };
  }
  if (strategy === "random") {
    return { products: [...products].sort((a, b) => stableRandom(seed, a.id) - stableRandom(seed, b.id)).slice(0, limit), clusters: [] };
  }
  const coordinates = normalizedCoordinates(products);
  const centroid = products.reduce((point, product) => {
    const coordinate = coordinates.get(product.id)!;
    point.x += coordinate.x / products.length;
    point.y += coordinate.y / products.length;
    return point;
  }, { x: 0, y: 0 });
  return {
    products: [...products].sort((left, right) => {
      const a = coordinates.get(left.id)!;
      const b = coordinates.get(right.id)!;
      return Math.hypot(b.x - centroid.x, b.y - centroid.y) - Math.hypot(a.x - centroid.x, a.y - centroid.y);
    }).slice(0, limit),
    clusters: [],
  };
}

function localApiUrl(path: string): URL {
  const base = new URL(process.env.MOSAIC_API_URL || "http://127.0.0.1:8788");
  if (!(["http:", "https:"].includes(base.protocol)
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname))) {
    throw new Error("MOSAIC_API_URL must point to a loopback Mosaic API.");
  }
  return new URL(path, base);
}

async function localApiRequest(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(localApiUrl(path), {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let payload: unknown;
  try { payload = raw ? JSON.parse(raw) : null; }
  catch { payload = { error: raw.slice(0, 2_000) || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(`Mosaic local API returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function persistedResearchRun(repository: CatalogRepository, scope: ResearchScope): ResearchRun {
  const run = repository.getResearchRun(scope.runId, scope.workspaceId);
  if (!run) throw new Error(`Unknown research run in workspace ${scope.workspaceId}: ${scope.runId}`);
  if (run.workspaceId !== scope.workspaceId || run.request.workspaceId !== scope.workspaceId) {
    throw new Error("Research run and workspace scope do not match.");
  }
  return run;
}

function compactJob(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactJob);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.jobs)) return { jobs: record.jobs.map(compactJob) };
  const keys = [
    "id", "source", "kind", "status", "rawStatus", "progress", "total", "totalItems",
    "completed", "succeeded", "succeededItems", "failed", "failedItems", "blocked",
    "blockedItems", "cancelled", "cancelledItems", "pendingItems", "discovered",
    "message", "error", "canResume", "terminal", "partial", "cooldownUntil", "createdAt",
    "startedAt", "updatedAt", "finishedAt",
  ];
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export function registerResearchTools(
  server: McpServer,
  repository: CatalogRepository,
  scope: ResearchScope,
): void {
  const workspace = workspaceOrThrow(repository, scope.workspaceId);
  const run = persistedResearchRun(repository, scope);
  const hardFilter = hardConstraintFilter(run);
  const contextAnchorIds = new Set([
    ...run.request.itemIds,
    ...run.manifest.selectedCollections.flatMap((collection) => collection.itemIds),
  ]);
  const researchProductOrThrow = (id: string, allowContextAnchor = false): Product => {
    const product = scopedProductOrThrow(repository, scope, id);
    if (hardFilter && !(allowContextAnchor && contextAnchorIds.has(id))
      && eligibleProducts([product], hardFilter).length === 0) {
      throw new Error(`Item ${id} is outside this run's hard constraints.`);
    }
    return product;
  };
  const meter = new ResearchBudgetMeter(mostRestrictiveBudget(
    run.request.budget,
    researchBudgetFromEnvironment(),
  ));
  const scopedResult = (value: unknown) => textResult({ data: value, budget: meter.snapshot() });

  server.registerTool("get_research_context", {
    title: "Get scoped research context",
    description: "Return the current run id, workspace manifest, dynamic field schema, facets, inventory, collections, and source capabilities. This process cannot enumerate another workspace.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    meter.consume({ itemsRead: run.manifest.selectedItems.length });
    const fields = repository.listFieldDefinitions(scope.workspaceId);
    const effectiveFields = fields.length > 0 ? fields : repository.inferWorkspaceSchema(scope.workspaceId);
    const products = repository.listProducts({ workspaceId: scope.workspaceId, limit: 10_000 });
    const currentManifest = run.manifest;
    return scopedResult({
      run: {
        id: run.id,
        workspaceId: run.workspaceId,
        status: run.status,
        prompt: run.request.prompt,
        inputs: {
          itemIds: run.request.itemIds,
          collectionIds: run.request.collectionIds,
          images: run.request.images,
          urls: run.request.urls,
        },
      },
      manifest: currentManifest,
      workspace,
      schema: {
        inferred: fields.length === 0,
        fields: effectiveFields,
        facets: repository.getWorkspaceFacets(
          scope.workspaceId,
          effectiveFields.filter((field) => field.facetable).map((field) => field.key),
        ),
      },
      inventory: workspaceInventory(products),
      collections: repository.listCollections(scope.workspaceId).map((collection) => ({
        id: collection.id,
        type: collection.type,
        name: collection.name,
        description: collection.description,
        itemCount: collection.items.length,
        itemIds: collection.items.slice(0, 160).map((item) => item.itemId),
      })),
      sources: sourceCapabilities(),
      limits: {
        queryItems: MAX_QUERY_ITEMS,
        sampleItems: MAX_SAMPLE_ITEMS,
        contactSheetItems: MAX_CONTACT_SHEET_ITEMS,
        browserObservations: MAX_BROWSER_OBSERVATIONS,
      },
    });
  });

  server.registerTool("query_workspace_items", {
    title: "Query scoped workspace items",
    description: "Search this workspace by text and/or the complete nested FilterSpec DSL. Returns factual item metadata without exposing any other workspace.",
    inputSchema: {
      query: z.string().trim().max(1_000).optional(),
      filter: filterSpecSchema.optional(),
      offset: z.number().int().min(0).max(10_000).default(0),
      limit: z.number().int().min(1).max(MAX_QUERY_ITEMS).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, filter, offset, limit }) => {
    meter.consume();
    const requested = Math.min(10_000, offset + limit);
    const products = repository.listProducts({
      workspaceId: scope.workspaceId,
      search: query,
      filter: mergeWithHardConstraints(filter as FilterSpec | undefined, hardFilter),
      limit: requested,
    });
    const items = products.slice(offset, offset + limit);
    meter.consumeWithoutTool({ itemsRead: items.length });
    return scopedResult({
      workspaceId: scope.workspaceId,
      totalMatchedWithinWindow: products.length,
      offset,
      items: items.map(conciseItem),
    });
  });

  server.registerTool("sample_workspace_items", {
    title: "Sample scoped workspace items",
    description: "Select a bounded evidence sample from this workspace. Strategies cover spatial and source/category diversity, recency, projection outliers, missing or uncertain metadata, deterministic randomness, and projection clusters.",
    inputSchema: {
      strategy: researchSampleStrategySchema.default("diverse"),
      query: z.string().trim().max(1_000).optional(),
      filter: filterSpecSchema.optional(),
      limit: z.number().int().min(1).max(MAX_SAMPLE_ITEMS).default(24),
      seed: z.string().trim().max(200).optional(),
      clusterKey: z.string().trim().max(40).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ strategy, query, filter, limit, seed, clusterKey }) => {
    meter.consume();
    const candidates = repository.listProducts({
      workspaceId: scope.workspaceId,
      search: query,
      filter: mergeWithHardConstraints(filter as FilterSpec | undefined, hardFilter),
      limit: 10_000,
    });
    const sample = sampleWorkspaceProducts({
      products: candidates,
      strategy,
      limit,
      seed: seed ?? scope.runId,
      clusterKey,
    });
    meter.consumeWithoutTool({ itemsRead: sample.products.length });
    return scopedResult({
      workspaceId: scope.workspaceId,
      strategy,
      candidateCount: candidates.length,
      sampleCount: sample.products.length,
      clusters: sample.clusters,
      items: sample.products.map(conciseItem),
    });
  });

  server.registerTool("get_source_capabilities", {
    title: "Get available acquisition capabilities",
    description: "Return installed source adapters and generic import handoffs. Capabilities describe mechanisms, not item domains.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    meter.consume();
    return scopedResult(sourceCapabilities());
  });

  server.registerTool("find_similar_workspace_items", {
    title: "Find similar scoped items",
    description: "Retrieve a bounded candidate set near one to twelve anchors using cached hybrid visual embeddings with projection fallback. Anchors and results are restricted to this workspace.",
    inputSchema: {
      itemIds: z.array(z.string().min(1)).min(1).max(12),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ itemIds, limit }) => {
    meter.consume();
    [...new Set(itemIds)].forEach((id) => researchProductOrThrow(id, true));
    const products = await findSimilarProducts({
      productIds: itemIds,
      limit,
      constraints: { workspaceId: scope.workspaceId },
    }, repository);
    const eligible = eligibleProducts(products, hardFilter).slice(0, limit);
    meter.consumeWithoutTool({ itemsRead: eligible.length });
    return scopedResult(eligible.map(conciseItem));
  });

  server.registerTool("rank_workspace_by_visual_references", {
    title: "Rank scoped items by visual references",
    description: "Use local cached CLIP signals from this run’s app-owned reference images and selected item anchors to rank a hard-filtered candidate pool. This is a bounded retrieval hint, not a frozen universe; combine it with query and sampling when useful.",
    inputSchema: {
      contextItemIds: z.array(z.string().min(1)).max(24).default([]),
      query: z.string().trim().max(1_000).optional(),
      filter: filterSpecSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ contextItemIds, query, filter, limit }) => {
    meter.consume({ imageInspections: run.request.images.length });
    const defaultContextIds = [
      ...run.request.itemIds,
      ...run.manifest.selectedCollections.flatMap((collection) => collection.itemIds),
    ];
    const anchors = [...new Set([...defaultContextIds, ...contextItemIds])].slice(0, 24);
    anchors.forEach((id) => researchProductOrThrow(id, true));
    const effectiveFilter = mergeWithHardConstraints(filter as FilterSpec | undefined, hardFilter);
    const candidates = repository.listProducts({
      workspaceId: scope.workspaceId,
      search: query,
      filter: effectiveFilter,
      limit: 10_000,
    });
    const result = await rankWorkspaceByVisualReferences({
      workspaceId: scope.workspaceId,
      referenceImagePaths: run.request.images.map((image) => image.mediaPath),
      contextItemIds: anchors,
      eligibleProductIds: candidates.map((product) => product.id),
      limit,
    }, repository);
    const candidatesById = new Map(candidates.map((product) => [product.id, product]));
    const ranked = result.ranked.flatMap((entry) => {
      const product = candidatesById.get(entry.product.id);
      return product ? [{ ...entry, product }] : [];
    }).slice(0, limit);
    meter.consumeWithoutTool({ itemsRead: ranked.length });
    return scopedResult({
      metadata: {
        ...result.metadata,
        hardConstraintCandidateCount: candidates.length,
        contextItemIds: anchors,
      },
      items: ranked.map(({ product, score, mode, referenceScores }) => ({
        ...conciseItem(product),
        visualRetrieval: { score, mode, referenceScores },
      })),
    });
  });

  server.registerTool("inspect_workspace_item", {
    title: "Inspect one scoped item image",
    description: "Return one item’s complete compact metadata and a safe rendered preview of a selected image.",
    inputSchema: {
      itemId: z.string().min(1),
      imageIndex: z.number().int().min(0).max(11).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ itemId, imageIndex }) => {
    meter.consume({ itemsRead: 1, imageInspections: 1 });
    const product = researchProductOrThrow(itemId, true);
    if (imageIndex >= product.images.length && product.images.length > 0) {
      throw new Error(`Item ${itemId} has ${product.images.length} image(s); index ${imageIndex} is unavailable.`);
    }
    const selectedImage = product.images[imageIndex];
    const previewProduct = selectedImage
      ? { ...product, images: [selectedImage, ...product.images.filter((_, index) => index !== imageIndex)] }
      : product;
    const preview = await buildProductPreview(previewProduct);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(conciseItem(product), null, 2) },
        { type: "text" as const, text: JSON.stringify({ budget: meter.snapshot() }) },
        { type: "image" as const, data: preview.toString("base64"), mimeType: "image/jpeg" },
      ],
    };
  });

  server.registerTool("build_workspace_contact_sheet", {
    title: "Build a scoped visual evidence sheet",
    description: "Render up to 36 known workspace items as a numbered contact sheet. Supply item ids from a query, sample, or similarity result.",
    inputSchema: {
      itemIds: z.array(z.string().min(1)).min(1).max(MAX_CONTACT_SHEET_ITEMS),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ itemIds }) => {
    const distinctCount = new Set(itemIds).size;
    meter.consume({ itemsRead: distinctCount, imageInspections: distinctCount });
    const products = [...new Set(itemIds)].map((id) => researchProductOrThrow(id, true));
    const sheet = await buildContactSheet(products);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            workspaceId: scope.workspaceId,
            path: sheet.path,
            items: products.map(({ id, brand, name }) => ({ id, brand, name })),
            budget: meter.snapshot(),
          }, null, 2),
        },
        { type: "image" as const, data: sheet.buffer.toString("base64"), mimeType: "image/jpeg" },
      ],
    };
  });

  server.registerTool("list_workspace_collections", {
    title: "List scoped collections",
    description: "List reusable selections in the current research workspace.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    meter.consume();
    return scopedResult(repository.listCollections(scope.workspaceId));
  });

  server.registerTool("create_workspace_collection", {
    title: "Create a scoped collection",
    description: "Create a reusable manual or AI-result selection in this workspace, optionally with known item ids.",
    inputSchema: {
      type: z.enum(["manual", "ai-result"]).default("ai-result"),
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2_000).default(""),
      itemIds: z.array(z.string().min(1)).max(160).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ type, name, description, itemIds }) => {
    meter.consume({ collectionWrites: 1 });
    const uniqueIds = [...new Set(itemIds)];
    uniqueIds.forEach((id) => researchProductOrThrow(id, true));
    let collection = repository.createCollection({
      workspaceId: scope.workspaceId,
      type,
      name,
      description,
    });
    if (uniqueIds.length > 0) {
      collection = repository.addCollectionItems(
        collection.id,
        uniqueIds.map((itemId) => ({ itemId })),
        scope.workspaceId,
      );
    }
    return scopedResult(collection);
  });

  server.registerTool("add_workspace_items_to_collection", {
    title: "Add scoped items to a collection",
    description: "Add known items to a collection in this workspace while preserving current membership and order.",
    inputSchema: {
      collectionId: z.string().min(1),
      itemIds: z.array(z.string().min(1)).min(1).max(160),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ collectionId, itemIds }) => {
    meter.consume({ collectionWrites: 1 });
    if (!repository.getCollection(collectionId, scope.workspaceId)) {
      throw new Error(`Unknown collection in this research workspace: ${collectionId}`);
    }
    const uniqueIds = [...new Set(itemIds)];
    uniqueIds.forEach((id) => researchProductOrThrow(id, true));
    return scopedResult(repository.addCollectionItems(
      collectionId,
      uniqueIds.map((itemId) => ({ itemId })),
      scope.workspaceId,
    ));
  });

  server.registerTool("save_workspace_filter", {
    title: "Save a scoped editable filter",
    description: "Validate and save a complete nested FilterSpec in this workspace.",
    inputSchema: { filter: filterSpecSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ filter }) => {
    meter.consume();
    return scopedResult(repository.saveFilter(filter, scope.workspaceId));
  });

  server.registerTool("annotate_workspace_items", {
    title: "Annotate scoped items",
    description: "Apply decisions, tags, annotations, arbitrary attributes, or named 0–100 scores to known items in this workspace.",
    inputSchema: {
      itemIds: z.array(z.string().min(1)).min(1).max(500),
      patch: productPatchSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ itemIds, patch }) => {
    meter.consume();
    const ids = [...new Set(itemIds)];
    ids.forEach((id) => researchProductOrThrow(id, true));
    return scopedResult({ updated: repository.patchProducts(ids, patch, scope.workspaceId) });
  });

  server.registerTool("import_workspace_links", {
    title: "Import public item links",
    description: "Import a bounded list of user-supplied public HTTPS item pages through safe structured-data readers. Successful imports remain in this workspace.",
    inputSchema: { urls: z.array(z.string().url().max(2_000)).min(1).max(24) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ urls }) => {
    meter.consume({ acquisitionJobs: 1, acquiredItems: urls.length });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const result = await importPublicProductUrls(urls, repository, controller.signal, {
        workspaceId: scope.workspaceId,
      });
      if (result.products.length > 0) reprojectWorkspace(repository, scope.workspaceId);
      const matchingProducts = eligibleProducts(result.products, hardFilter);
      return scopedResult({
        ...result,
        products: matchingProducts,
        retainedOutsideHardConstraints: result.products.length - matchingProducts.length,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  server.registerTool("import_browser_observations", {
    title: "Import browser observations",
    description: "Persist factual public item observations supplied by a separately configured user-visible browser. This tool does not browse by itself.",
    inputSchema: { items: z.array(browserObservationSchema).min(1).max(MAX_BROWSER_OBSERVATIONS) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ items }) => {
    meter.consume({ acquiredItems: items.length });
    const now = new Date().toISOString();
    const products = items.map((item) => {
      const safePageUrl = normalizePublicHttpsUrl(item.url);
      if (!safePageUrl) throw new Error(`Only public HTTPS item pages are allowed: ${item.url}`);
      const requested = new URL(safePageUrl);
      if (item.variantAvailabilityKnown && (!item.observedAt || item.stockStatus === "unknown")) {
        throw new Error(`Verified variants require a timestamp and explicit stock status: ${item.name}`);
      }
      const images = [...new Set(item.images.map((image) => {
        const safeUrl = normalizePublicHttpsUrl(image, requested);
        if (!safeUrl) throw new Error(`Only public HTTPS item images are allowed: ${image}`);
        return safeUrl;
      }))];
      const source = item.source?.trim() || `browser:${requested.hostname.toLocaleLowerCase()}`;
      const sourceId = item.sourceId?.trim() || `${requested.pathname}${requested.search}`;
      return productSchema.parse({
        id: stableWorkspaceProductId(scope.workspaceId, source, sourceId),
        workspaceId: scope.workspaceId,
        kind: "shop",
        source,
        sourceId,
        url: requested.href,
        brand: item.brand,
        name: item.name,
        description: item.description,
        price: item.price,
        originalPrice: item.originalPrice,
        currency: item.currency.toLocaleUpperCase(),
        category: item.category,
        color: item.color,
        colorFamily: item.colorFamily,
        fit: item.fit,
        attributes: {
          ...item.attributes,
          variantAvailabilityKnown: item.variantAvailabilityKnown,
          extractedVia: "browser-observation",
          canonicalUrl: requested.href,
        },
        materials: item.materials,
        tags: item.tags,
        sizes: item.variantAvailabilityKnown ? item.availableVariantLabels : [],
        images,
        available: item.stockStatus !== "out_of_stock",
        stockStatus: item.stockStatus,
        stockCheckedAt: item.stockStatus === "unknown" ? null : item.observedAt,
        sizesCheckedAt: item.variantAvailabilityKnown ? item.observedAt : null,
        priceCheckedAt: item.price === null ? null : item.observedAt,
        decision: "unseen",
        x: 0.5,
        y: 0.5,
        scores: {},
        importedAt: now,
        updatedAt: now,
      });
    });
    const matchingProducts = eligibleProducts(products, hardFilter);
    repository.upsertCollectedProducts(matchingProducts);
    if (matchingProducts.length > 0) reprojectWorkspace(repository, scope.workspaceId);
    return scopedResult({
      imported: matchingProducts.length,
      rejectedByHardConstraints: products.length - matchingProducts.length,
      items: matchingProducts.map((product) => conciseItem(
        repository.getProduct(product.id, scope.workspaceId) ?? product,
      )),
    });
  });

  server.registerTool("start_source_discovery", {
    title: "Start bounded source discovery",
    description: "Start one bounded local discovery job through an installed source adapter. Use get_source_capabilities before choosing a source id.",
    inputSchema: {
      sourceId: z.string().trim().min(1).max(100),
      query: z.string().trim().max(2_000).optional(),
      category: z.string().trim().max(160).optional(),
      variantLabels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
      minPrice: z.number().nonnegative().optional(),
      maxPrice: z.number().nonnegative().optional(),
      listingUrl: z.string().url().max(2_000).optional(),
      maxItems: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    meter.consume({ acquisitionJobs: 1, acquiredItems: input.maxItems });
    const adapter = listAdapters().find((candidate) => candidate.id === input.sourceId);
    if (!adapter) throw new Error(`Unknown source adapter: ${input.sourceId}`);
    discoveryAdapterFor(adapter.id as DiscoverySource);
    const payload = await localApiRequest("/api/discovery/jobs", {
      method: "POST",
      body: {
        workspaceId: scope.workspaceId,
        intent: {
          source: adapter.id,
          query: input.query,
          category: input.category,
          sizes: input.variantLabels.length > 0 ? input.variantLabels : undefined,
          sizeMode: "any",
          minPrice: input.minPrice,
          maxPrice: input.maxPrice,
          listingUrl: input.listingUrl,
          maxItems: input.maxItems,
        },
      },
    });
    return scopedResult(compactJob(payload));
  });

  server.registerTool("get_source_discovery", {
    title: "Get scoped discovery status",
    description: "Read one discovery job from this workspace without starting or resuming network work.",
    inputSchema: { jobId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    meter.consume();
    return scopedResult(compactJob(await localApiRequest(
      `/api/discovery/jobs/${encodeURIComponent(jobId)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`,
    )));
  });

  server.registerTool("control_source_discovery", {
    title: "Control scoped discovery",
    description: "Explicitly cancel, retry, or resume a discovery job that belongs to this workspace.",
    inputSchema: {
      jobId: z.string().min(1).max(200),
      action: z.enum(["cancel", "retry", "resume"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ jobId, action }) => {
    meter.consume();
    return scopedResult(compactJob(await localApiRequest(
      `/api/discovery/jobs/${encodeURIComponent(jobId)}/${action}?workspaceId=${encodeURIComponent(scope.workspaceId)}`,
      { method: "POST" },
    )));
  });

  server.registerTool("refresh_workspace_items", {
    title: "Refresh scoped item facts",
    description: "Start bounded detail refreshes for known source items in this workspace.",
    inputSchema: { itemIds: z.array(z.string().min(1)).min(1).max(120) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ itemIds }) => {
    meter.consume({ acquisitionJobs: 1 });
    const ids = [...new Set(itemIds)];
    ids.forEach((id) => researchProductOrThrow(id, true));
    return scopedResult(compactJob(await localApiRequest("/api/acquisition/jobs", {
      method: "POST",
      body: { workspaceId: scope.workspaceId, productIds: ids },
    })));
  });

  server.registerTool("get_item_refresh", {
    title: "Get scoped refresh status",
    description: "Read one detail-refresh job that belongs to this workspace.",
    inputSchema: { jobId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    meter.consume();
    return scopedResult(compactJob(await localApiRequest(
      `/api/acquisition/jobs/${encodeURIComponent(jobId)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`,
    )));
  });

  server.registerTool("control_item_refresh", {
    title: "Control scoped refresh",
    description: "Explicitly cancel, retry, or resume a detail-refresh job that belongs to this workspace.",
    inputSchema: {
      jobId: z.string().min(1).max(200),
      action: z.enum(["cancel", "retry", "resume"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ jobId, action }) => {
    meter.consume();
    return scopedResult(compactJob(await localApiRequest(
      `/api/acquisition/jobs/${encodeURIComponent(jobId)}/${action}?workspaceId=${encodeURIComponent(scope.workspaceId)}`,
      { method: "POST" },
    )));
  });
}
