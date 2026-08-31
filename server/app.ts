import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  decisionSchema,
  filterSpecSchema,
  productPatchSchema,
  productSchema,
  type FilterExpression,
} from "../src/domain/catalog";
import { stableProductId } from "../src/domain/ids";
import {
  DEFAULT_CLOTHING_WORKSPACE_ID,
  artifactCreateSchema,
  artifactPublicUpdateSchema,
  collectionCreateSchema,
  collectionItemInputSchema,
  collectionUpdateSchema,
  fieldDefinitionInputSchema,
  workspaceCreateSchema,
  workspaceUpdateSchema,
  type ArtifactCreate,
  type RunView,
} from "../src/domain/workspace";
import { researchRequestObjectSchema } from "../src/domain/research";
import { normalizeProduct } from "../collector/normalize";
import type { DiscoveryIntent, RawProduct } from "../collector/types";
import {
  AcquisitionService,
  PlaywrightDetailFetcher,
  acquisitionClientView,
} from "./acquisition";
import { catalogMediaPath, catalogMediaType, deleteCatalogMedia, persistCatalogImages } from "./media";
import { generateOutfits } from "./outfit-generator";
import { projectCompactCached, type ProjectionMode } from "./projection-cache";
import { importPublicProductUrls, isPublicShopHostname } from "./public-product-import";
import { CatalogRepository } from "./repository";
import { createFilterWithCodex } from "./codex-bridge";
import { createDiscoveryPlanWithCodex } from "./codex-discovery";
import { createAssistantPlanWithCodex, type AssistantPlan, type AssistantStep } from "./codex-assistant";
import {
  DiscoveryService,
  FileDiscoveryJobStore,
  PlaywrightDiscoveryFetcher,
  type DiscoveryJobSnapshot,
} from "./discovery";
import { getEmbeddingJob, startEmbeddingJob } from "./embedding-job";
import { attachImageAspectRatios } from "./image-aspect-ratios";
import { getVisualSelection, startVisualSelection } from "./visual-selection";
import { findSimilarProducts } from "./similarity";
import { visualConstraintsSchema } from "./visual-constraints";
import { ResearchAgentService } from "./research-agent";

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
  workspaceId: z.string().trim().min(1).max(128).optional(),
});

const referenceItemSchema = catalogItemFieldsSchema.extend({
  workspaceId: z.string().trim().min(1).max(128).optional(),
  attributes: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ).optional(),
});

const publicProductUrlSchema = z.object({
  url: z.string().url().max(2_000),
  workspaceId: z.string().trim().min(1).max(128).optional(),
});

const assistantFieldKeySchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
  .refine((value) => !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)));

const assistantFieldConstraintsSchema = z.object({
  facets: z.record(
    assistantFieldKeySchema,
    z.array(z.union([z.string().max(300), z.number(), z.boolean()])).max(40),
  ).default({}),
  numbers: z.record(
    assistantFieldKeySchema,
    z.object({
      min: z.union([z.string().max(80), z.number()]).optional(),
      max: z.union([z.string().max(80), z.number()]).optional(),
    }),
  ).default({}),
}).superRefine((value, context) => {
  if (Object.keys(value.facets).length + Object.keys(value.numbers).length > 50) {
    context.addIssue({ code: "custom", message: "At most 50 dynamic field constraints are allowed." });
  }
});

const assistantRequestSchema = z.object({
  prompt: z.string().trim().max(8_000).default(""),
  workspaceId: z.string().trim().min(1).max(128).default(DEFAULT_CLOTHING_WORKSPACE_ID),
  productIds: z.array(z.string().min(1)).max(40).default([]),
  collectionIds: z.array(z.string().min(1)).max(12).default([]),
  images: z.array(z.object({ name: z.string().max(180).optional(), dataUrl: z.string().min(1) })).max(6).default([]),
  constraints: z.object({
    sizes: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    shops: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    minPrice: z.number().nonnegative().optional(),
    maxPrice: z.number().nonnegative().optional(),
    includeRejected: z.boolean().optional(),
    fields: assistantFieldConstraintsSchema.optional(),
  }).default({}),
  analysisMode: z.enum(["sequential", "sheet"]).default("sequential"),
  reasoningEffort: z.enum(["low", "medium"]).default("low"),
});

const artifactRequestImagesSchema = z.array(z.object({
  name: z.string().trim().max(180).optional(),
  dataUrl: z.string().min(1),
})).max(6).default([]);

const researchApiRequestSchema = researchRequestObjectSchema.omit({ images: true }).extend({
  images: artifactRequestImagesSchema,
});

function assistantFieldsWhere(
  fields: z.infer<typeof assistantFieldConstraintsSchema> | undefined,
): FilterExpression | undefined {
  if (!fields) return undefined;
  const children: FilterExpression[] = [];
  for (const [field, rawValues] of Object.entries(fields.facets)) {
    const values = [...new Set(rawValues.map((value) => String(value).trim()).filter(Boolean))];
    if (values.length) children.push({ type: "clause", field, operator: "in", value: values });
  }
  for (const [field, range] of Object.entries(fields.numbers)) {
    const min = range.min === undefined || range.min === "" ? undefined : Number(range.min);
    const max = range.max === undefined || range.max === "" ? undefined : Number(range.max);
    if (min !== undefined && Number.isFinite(min)) children.push({ type: "clause", field, operator: "gte", value: min });
    if (max !== undefined && Number.isFinite(max)) children.push({ type: "clause", field, operator: "lte", value: max });
  }
  return children.length ? { type: "group", conjunction: "and", children } : undefined;
}

function assistantHardWhere(input: {
  sources?: string[];
  categories?: string[];
  sizes?: string[];
  minPrice?: number;
  maxPrice?: number;
  includeRejected: boolean;
  dynamicWhere?: FilterExpression;
}): FilterExpression | undefined {
  const children: FilterExpression[] = [];
  if (!input.includeRejected) children.push({ type: "clause", field: "decision", operator: "neq", value: "rejected" });
  if (input.sources?.length) children.push({ type: "clause", field: "source", operator: "in", value: input.sources });
  if (input.categories?.length) children.push({ type: "clause", field: "category", operator: "in", value: input.categories });
  if (input.minPrice !== undefined) children.push({ type: "clause", field: "price", operator: "gte", value: input.minPrice });
  if (input.maxPrice !== undefined) children.push({ type: "clause", field: "price", operator: "lte", value: input.maxPrice });
  if (input.sizes?.length) {
    children.push(
      { type: "clause", field: "sizes", operator: "in", value: input.sizes },
      { type: "clause", field: "stockStatus", operator: "eq", value: "in_stock" },
      { type: "clause", field: "attributes.sizeAvailabilityKnown", operator: "eq", value: true },
      {
        type: "clause",
        field: "sizesCheckedAt",
        operator: "gte",
        value: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
      },
    );
  }
  if (input.dynamicWhere) children.push(input.dynamicWhere);
  return children.length ? { type: "group", conjunction: "and", children } : undefined;
}

function assistantLinks(prompt: string): string[] {
  return [...new Set((prompt.match(/https:\/\/[^\s<>"']+/gi) ?? [])
    .map((value) => value.replace(/[),.;!?\]}]+$/g, "")))]
    .slice(0, 12);
}

function assistantShopId(value: string): DiscoveryIntent["source"] | null {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.includes("zalando")) return "zalando-ch";
  if (normalized.includes("aboutyou")) return "aboutyou-ch";
  if (normalized.includes("aliexpress")) return "aliexpress";
  return null;
}

type AssistantDiscoverStep = Extract<AssistantStep, { type: "discover_adapter" }>;
type AssistantEnrichStep = Extract<AssistantStep, { type: "enrich" }>;
type AssistantArtifactStep = Extract<AssistantStep, { type: "artifact" }>;

type AssistantDiscoveryPlanView = {
  id: string;
  name: string;
  description: string;
  targetCount: number;
  sizes: string[];
  sizeMode: "any";
  model?: string;
  searches: Array<{
    source: DiscoveryIntent["source"];
    query: string;
    category: string;
    minPrice: number;
    maxPrice: number;
    maxItems: number;
    reason: string;
  }>;
};

const assistantArtifactContinuationV2Schema = z.object({
  version: z.literal(2),
  kind: z.literal("assistant-to-artifact"),
  workspaceId: z.string().min(1),
  jobIds: z.array(z.string().min(1)).max(10),
  seedProductIds: z.array(z.string().min(1)).max(160).default([]),
  targetCount: z.number().int().min(1).max(12),
  generationRequested: z.boolean(),
  enrichment: z.object({
    stepIds: z.array(z.string().min(1)).min(1).max(11),
    fields: z.array(z.string().min(1).max(100)).min(1).max(264),
    targetCount: z.number().int().min(1).max(160),
    jobId: z.string().min(1).optional(),
    productIds: z.array(z.string().min(1)).max(160).default([]),
    status: z.enum(["planned", "running", "succeeded", "partial", "failed", "blocked"]).default("planned"),
  }).optional(),
  status: z.enum(["queued", "discovering", "enriching", "draft", "blocked", "failed"]).optional(),
  partial: z.boolean().optional(),
  jobStatuses: z.record(z.string(), z.string()).optional(),
  discoveredProductIds: z.array(z.string().min(1)).max(600).optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

const assistantArtifactContinuationSchema = z.union([
  assistantArtifactContinuationV2Schema,
  z.object({
    version: z.literal(1),
    kind: z.literal("discover-to-artifact"),
    workspaceId: z.string().min(1),
    jobIds: z.array(z.string().min(1)).min(1).max(10),
    targetCount: z.number().int().min(1).max(12),
    generationRequested: z.boolean(),
    createdAt: z.string().datetime(),
  }).transform((legacy) => assistantArtifactContinuationV2Schema.parse({
    ...legacy,
    version: 2,
    kind: "assistant-to-artifact",
    seedProductIds: [],
  })),
]);

type AssistantArtifactContinuation = z.infer<typeof assistantArtifactContinuationSchema>;

function assistantUpstreamSteps(plan: AssistantPlan, targetStepId: string): AssistantStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const step = byId.get(id);
    if (!step) return;
    step.dependsOn.forEach(visit);
  };
  const target = byId.get(targetStepId);
  target?.dependsOn.forEach(visit);
  return plan.steps.filter((step) => visited.has(step.id));
}

function assistantFallbackDiscoveryPlan(
  step: AssistantDiscoverStep,
  plan: AssistantPlan,
): AssistantDiscoveryPlanView {
  const requestedSources = step.sources.length ? step.sources : plan.effectiveShops;
  const sources = [...new Set(requestedSources.map(assistantShopId).filter(Boolean))] as DiscoveryIntent["source"][];
  const usableSources: DiscoveryIntent["source"][] = sources.length
    ? sources
    : ["zalando-ch", "aboutyou-ch", "aliexpress"];
  const targetCount = Math.min(300, Math.max(1, step.targetCount));
  const searches: AssistantDiscoveryPlanView["searches"] = [];
  let remaining = targetCount;
  let sourceIndex = 0;
  const jobCount = Math.min(10, Math.max(
    1,
    Math.ceil(targetCount / 60),
    Math.min(usableSources.length, targetCount),
  ));
  while (remaining > 0 && searches.length < jobCount) {
    const source = usableSources[sourceIndex % usableSources.length]!;
    const slotsLeft = Math.max(1, jobCount - searches.length);
    const maxItems = Math.min(60, Math.max(1, Math.ceil(remaining / slotsLeft)));
    searches.push({
      source,
      query: step.query,
      category: "Produits",
      minPrice: plan.effectiveMinPrice ?? 0,
      maxPrice: plan.effectiveMaxPrice ?? 0,
      maxItems,
      reason: "Plan local de secours quand le routeur Codex est indisponible.",
    });
    remaining -= maxItems;
    sourceIndex += 1;
  }
  return {
    id: crypto.randomUUID(),
    name: step.title,
    description: `Découverte bornée pour « ${step.query} »`,
    targetCount: searches.reduce((sum, search) => sum + search.maxItems, 0),
    sizes: plan.effectiveSizes,
    sizeMode: "any",
    model: "heuristic",
    searches,
  };
}

async function assistantDiscoveryPlan(
  step: AssistantDiscoverStep,
  plan: AssistantPlan,
): Promise<AssistantDiscoveryPlanView> {
  try {
    return await createDiscoveryPlanWithCodex(step.query, { sizes: plan.effectiveSizes });
  } catch {
    return assistantFallbackDiscoveryPlan(step, plan);
  }
}

function assistantArtifactType(step: AssistantArtifactStep) {
  return step.artifactKind === "report"
    ? "report" as const
    : step.artifactKind === "comparison"
      ? "comparison" as const
      : step.artifactKind === "studio"
        ? "other" as const
        : "image" as const;
}

function assistantDiscoveredProductIds(
  repository: CatalogRepository,
  workspaceId: string,
  jobs: DiscoveryJobSnapshot[],
): string[] {
  const products = repository.listProducts({ workspaceId, limit: 10_000 });
  const bySourceId = new Map(products.map((product) => [`${product.source}:${product.sourceId}`, product.id]));
  const byUrl = new Map(products.map((product) => [`${product.source}:${product.url}`, product.id]));
  const ids: string[] = [];
  for (const job of jobs) {
    for (const raw of job.results) {
      const id = (raw.sourceId ? bySourceId.get(`${job.source}:${raw.sourceId}`) : undefined)
        ?? byUrl.get(`${job.source}:${raw.url}`);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

async function createArtifactWithLocalImages(
  repository: CatalogRepository,
  input: Omit<ArtifactCreate, "id" | "localFiles">,
  images: Array<{ name?: string; dataUrl: string }> = [],
) {
  const id = `artifact-${crypto.randomUUID()}`;
  const mediaId = `artifact-${id}`;
  let localFiles: string[] = [];
  try {
    localFiles = await persistCatalogImages(mediaId, images.map((image) => image.dataUrl));
    return repository.createArtifact({ ...input, id, localFiles });
  } catch (error) {
    await deleteCatalogMedia(mediaId).catch(() => undefined);
    throw error;
  }
}

function boundedLimit(value: string | undefined, fallback = 100, maximum = 1_000): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.trunc(parsed))) : fallback;
}

function requestedProjectionMode(value: string | undefined): ProjectionMode {
  return value === "visual" || value === "metadata" ? value : "hybrid";
}

function collectionView(collection: ReturnType<CatalogRepository["createCollection"]>) {
  return {
    ...collection,
    kind: collection.type,
    itemIds: collection.items.map((item) => item.itemId),
  };
}

function workspaceUiSchema(repository: CatalogRepository, workspaceId: string) {
  let workspace = repository.getWorkspace(workspaceId);
  if (!workspace) return null;
  let fields = repository.listFieldDefinitions(workspaceId);
  let inferred = false;
  if (!fields.length && workspace.schemaVersion === 1) {
    const suggestions = repository.inferWorkspaceSchema(workspaceId);
    if (suggestions.length) {
      fields = repository.commitWorkspaceSchema(workspaceId, suggestions, { replace: true });
      workspace = repository.getWorkspace(workspaceId)!;
    } else {
      // There is nothing useful to commit yet. A later import may establish
      // enough coverage for the one-time initial schema inference.
      inferred = true;
    }
  }
  const facetable = fields.filter((field) => field.facetable);
  const facetDetails = repository.getWorkspaceFacets(workspaceId, facetable.map((field) => field.key));
  const facetByKey = new Map(facetDetails.map((facet) => [facet.fieldKey, facet]));
  return {
    workspace,
    inferred,
    fields: fields.map((field) => ({
      ...field,
      type: field.primitiveType,
      options: facetByKey.get(field.key)?.values.map(({ value }) => value) ?? [],
    })),
    facets: Object.fromEntries(facetDetails.map((facet) => [
      facet.fieldKey,
      facet.values.map(({ value, count }) => ({ value, label: String(value), count })),
    ])),
    facetDetails,
  };
}

function outfitView(board: ReturnType<CatalogRepository["saveOutfitBoard"]>) {
  return {
    ...board,
    productIds: board.items.map((item) => item.productId),
  };
}

function planSearchUsesGarmentSizes(search: { source: string; category: string; query: string }): boolean {
  if (search.source !== "zalando-ch" && search.source !== "aboutyou-ch") return false;
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
    onRequestStart(url, observedAt) {
      acquisition.noteShopRequest(url, observedAt);
    },
    isKnownProduct(raw: RawProduct, source, intent) {
      const workspaceId = intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
      return repository.listProducts({ workspaceId, limit: 10_000 }).some((product) => (
        product.source === source
        && ((raw.sourceId && product.sourceId === raw.sourceId) || product.url === raw.url)
      ));
    },
    async onProducts(rawProducts, context) {
      const workspaceId = (context.intent as DiscoveryIntent & { workspaceId?: string }).workspaceId
        ?? DEFAULT_CLOTHING_WORKSPACE_ID;
      const products = rawProducts.map((raw) => normalizeProduct(
        context.intent.source,
        raw,
        workspaceId,
      ));
      repository.upsertCollectedProducts(products);
      const allProducts = repository.listProducts({ workspaceId, limit: 10_000 });
      repository.replaceCoordinates(projectCompactCached(allProducts));
      if (!context.intent.sizes?.length) return;
      const needsDetail = products.filter((product) => product.attributes.sizeAvailabilityKnown !== true);
      for (let offset = 0; offset < needsDetail.length; offset += 120) {
        const targets = needsDetail.slice(offset, offset + 120).map((product) => ({
          productId: product.id,
          url: product.url,
        }));
        if (targets.length) {
          const detailJob = acquisition.start({
            targets,
            workspaceId,
            source: `discovery:${context.jobId}`,
          });
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
  acquisition = new AcquisitionService(repository, {
    // Direct structured reads stay invisible; only a refused/client-rendered
    // page opens the dedicated visible Chrome session. Headless Chrome is
    // rejected by several supported shops even at a human request rate.
    fetcher: new PlaywrightDetailFetcher({ headed: true }),
    sameDomainDelayMs: 8_000,
    sameDomainJitterMs: 4_000,
  }),
  discovery = createDiscoveryService(repository, acquisition),
  options: {
    assistantPlanner?: typeof createAssistantPlanWithCodex;
    researchAgent?: ResearchAgentService;
  } = {},
) {
  const app = new Hono();
  const research = options.researchAgent ?? new ResearchAgentService(repository);
  // A persisted size scan is expected to keep running in the background after
  // a local API reload. Only rate-limit cooldowns are restored automatically;
  // login/CAPTCHA blocks remain manual.
  queueMicrotask(() => acquisition.recoverLatestSizeEnrichment());
  queueMicrotask(() => research.markInterruptedRuns());
  let interactiveDiscovery: DiscoveryService | null = null;
  const interactiveDiscoveryJobs = new Set<string>();
  let assistantDiscoveryListener: ((job: DiscoveryJobSnapshot) => void) | null = null;
  const getInteractiveDiscovery = () => {
    if (!interactiveDiscovery) {
      interactiveDiscovery = createDiscoveryService(repository, acquisition, { headed: true });
      interactiveDiscovery.subscribe((job) => assistantDiscoveryListener?.(job));
    }
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
  const listDiscoveryJobs = (limit: number) => {
    const normal = discovery.list(limit);
    if (!interactiveDiscovery) return normal;
    const interactiveById = new Map(interactiveDiscovery.list(limit).map((job) => [job.id, job]));
    return normal.map((job) => interactiveDiscoveryJobs.has(job.id)
      ? interactiveById.get(job.id) ?? job
      : job);
  };
  research.setCancellationHandler((run, childJobs) => {
    for (const child of childJobs) {
      try {
        if (child.kind === "discovery") {
          const service = discoveryForJob(child.id);
          const job = service.get(child.id);
          if (job && (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) === run.workspaceId) {
            service.cancel(child.id);
          }
        } else {
          const job = acquisition.get(child.id);
          if (job?.workspaceId === run.workspaceId) acquisition.cancel(child.id);
        }
      } catch {
        // A completed or independently cancelled child must not prevent the
        // parent research run from reaching its terminal cancelled state.
      }
    }
  });
  const activeAssistantContinuations = new Set<string>();
  const terminalDiscoveryStatuses = new Set(["succeeded", "failed", "blocked", "cancelled"]);
  const terminalAcquisitionStatuses = new Set(["succeeded", "failed", "blocked", "cancelled"]);
  const continuableArtifactStatuses = new Set(["queued", "blocked", "failed"]);
  const continueAssistantArtifact = async (artifactId: string) => {
    if (activeAssistantContinuations.has(artifactId)) return;
    const artifact = repository.getArtifact(artifactId);
    if (!artifact || !continuableArtifactStatuses.has(artifact.status)) return;
    const parsedContinuation = assistantArtifactContinuationSchema.safeParse(
      artifact.provenance.assistantContinuation,
    );
    if (!parsedContinuation.success) return;
    activeAssistantContinuations.add(artifactId);
    try {
      const continuation = parsedContinuation.data;
      const jobs = continuation.jobIds.map((id) => discoveryForJob(id).get(id));
      if (jobs.some((job) => !job)) {
        repository.updateArtifact(artifactId, {
          status: "failed",
          error: "La continuation ne retrouve plus tous ses jobs de découverte persistés.",
          provenance: {
            ...artifact.provenance,
            assistantContinuation: { ...continuation, status: "failed", completedAt: new Date().toISOString() },
          },
        });
        return;
      }
      const snapshots = jobs as DiscoveryJobSnapshot[];
      if (snapshots.some((job) => !terminalDiscoveryStatuses.has(job.status))) return;

      const discoveredIds = assistantDiscoveredProductIds(repository, continuation.workspaceId, snapshots);
      const jobStatuses = Object.fromEntries(snapshots.map((job) => [job.id, job.status]));
      const discoveryPartial = snapshots.some((job) => job.status !== "succeeded");
      if (snapshots.length && !discoveredIds.length) {
        const blocked = snapshots.some((job) => job.status === "blocked" || job.status === "cancelled");
        repository.updateArtifact(artifactId, {
          status: blocked ? "blocked" : "failed",
          error: blocked
            ? "La découverte a été bloquée ou arrêtée avant de produire un élément utilisable."
            : "La découverte s’est terminée sans produit utilisable pour cet artefact.",
          provenance: {
            ...artifact.provenance,
            assistantContinuation: {
              ...continuation,
              status: blocked ? "blocked" : "failed",
              completedAt: new Date().toISOString(),
              partial: discoveryPartial,
              jobStatuses,
              discoveredProductIds: discoveredIds,
            },
          },
        });
        return;
      }

      let pipelineProductIds = snapshots.length ? discoveredIds : continuation.seedProductIds;
      let enrichmentPartial = false;
      let enrichment = continuation.enrichment;
      if (enrichment) {
        if (!enrichment.jobId) {
          const seen = new Set<string>();
          const targets = pipelineProductIds.flatMap((id) => {
            const product = repository.getProduct(id, continuation.workspaceId);
            if (!product || product.kind !== "shop" || seen.has(product.url)) return [];
            seen.add(product.url);
            return [{ productId: product.id, url: product.url }];
          }).slice(0, enrichment.targetCount);
          if (!targets.length) {
            repository.updateArtifact(artifactId, {
              status: "failed",
              error: "L’étape d’enrichissement n’a reçu aucune fiche produit de boutique exploitable.",
              provenance: {
                ...artifact.provenance,
                assistantContinuation: {
                  ...continuation,
                  status: "failed",
                  completedAt: new Date().toISOString(),
                  partial: discoveryPartial,
                  jobStatuses,
                  discoveredProductIds: discoveredIds,
                  enrichment: { ...enrichment, productIds: pipelineProductIds, status: "failed" },
                },
              },
            });
            return;
          }
          const enrichmentJob = acquisition.start({
            targets,
            workspaceId: continuation.workspaceId,
            source: `assistant:${artifactId}`,
          });
          enrichment = {
            ...enrichment,
            jobId: enrichmentJob.id,
            productIds: targets.map((target) => target.productId),
            status: "running",
          };
          repository.updateArtifact(artifactId, {
            status: "queued",
            error: null,
            provenance: {
              ...artifact.provenance,
              assistantContinuation: {
                ...continuation,
                status: "enriching",
                partial: discoveryPartial,
                jobStatuses,
                discoveredProductIds: discoveredIds,
                enrichment,
              },
            },
          });
          return;
        }

        const enrichmentJob = acquisition.get(enrichment.jobId);
        if (!enrichmentJob) {
          repository.updateArtifact(artifactId, {
            status: "failed",
            error: "La continuation ne retrouve plus son job d’enrichissement persisté.",
            provenance: {
              ...artifact.provenance,
              assistantContinuation: {
                ...continuation,
                status: "failed",
                completedAt: new Date().toISOString(),
                partial: discoveryPartial,
                jobStatuses,
                discoveredProductIds: discoveredIds,
                enrichment: { ...enrichment, status: "failed" },
              },
            },
          });
          return;
        }
        if (!terminalAcquisitionStatuses.has(enrichmentJob.status)) return;
        pipelineProductIds = enrichmentJob.items
          .filter((item) => item.status === "succeeded")
          .map((item) => item.productId);
        enrichmentPartial = enrichmentJob.status !== "succeeded";
        const enrichmentBlocked = enrichmentJob.status === "blocked" || enrichmentJob.status === "cancelled";
        if (!pipelineProductIds.length) {
          repository.updateArtifact(artifactId, {
            status: enrichmentBlocked ? "blocked" : "failed",
            error: enrichmentBlocked
              ? "L’enrichissement a été bloqué ou arrêté avant de vérifier un produit."
              : "L’enrichissement n’a vérifié aucun produit; l’artefact n’a pas été finalisé.",
            provenance: {
              ...artifact.provenance,
              assistantContinuation: {
                ...continuation,
                status: enrichmentBlocked ? "blocked" : "failed",
                completedAt: new Date().toISOString(),
                partial: true,
                jobStatuses,
                discoveredProductIds: discoveredIds,
                enrichment: { ...enrichment, status: enrichmentBlocked ? "blocked" : "failed" },
              },
            },
          });
          return;
        }
        enrichment = {
          ...enrichment,
          status: enrichmentPartial ? "partial" : "succeeded",
        };
      }

      const inputItemIds = [...new Set([...artifact.inputItemIds, ...pipelineProductIds])]
        .filter((id) => Boolean(repository.getProduct(id, continuation.workspaceId)))
        .slice(0, continuation.targetCount);
      const partial = discoveryPartial || enrichmentPartial;
      const completedAt = new Date().toISOString();
      const provenance = {
        ...artifact.provenance,
        assistantContinuation: {
          ...continuation,
          status: inputItemIds.length ? (continuation.generationRequested ? "blocked" : "draft")
            : snapshots.some((job) => job.status === "blocked" || job.status === "cancelled") ? "blocked" : "failed",
          completedAt,
          partial,
          jobStatuses,
          discoveredProductIds: discoveredIds,
          ...(enrichment ? { enrichment } : {}),
        },
      };
      if (!inputItemIds.length) {
        repository.updateArtifact(artifactId, {
          status: "failed",
          error: "Le pipeline s’est terminé sans produit utilisable pour cet artefact.",
          provenance,
        });
        return;
      }
      if (continuation.generationRequested) {
        repository.updateArtifact(artifactId, {
          status: "blocked",
          inputItemIds,
          generator: "not-configured",
          error: "Aucun fournisseur de génération n’est configuré. Les produits vérifiés ont été conservés dans le brouillon.",
          provenance,
        });
        return;
      }
      repository.updateArtifact(artifactId, {
        status: "draft",
        inputItemIds,
        error: partial ? "Brouillon créé à partir des résultats vérifiés; une étape distante n’a pas terminé normalement." : null,
        provenance,
      });
    } catch (error) {
      const current = repository.getArtifact(artifactId);
      if (current && continuableArtifactStatuses.has(current.status)) {
        repository.updateArtifact(artifactId, {
          status: "failed",
          error: error instanceof Error ? error.message : "La continuation assistant a échoué.",
          provenance: {
            ...current.provenance,
            assistantContinuation: {
              ...(typeof current.provenance.assistantContinuation === "object" && current.provenance.assistantContinuation !== null
                ? current.provenance.assistantContinuation : {}),
              status: "failed",
              completedAt: new Date().toISOString(),
            },
          },
        });
      }
    } finally {
      activeAssistantContinuations.delete(artifactId);
    }
  };
  const continueArtifactsForDiscoveryJob = (jobId: string) => {
    for (const workspace of repository.listWorkspaces()) {
      for (const artifact of repository.listArtifacts(workspace.id, { limit: 1_000 })) {
        if (!continuableArtifactStatuses.has(artifact.status)) continue;
        const continuation = assistantArtifactContinuationSchema.safeParse(
          artifact.provenance.assistantContinuation,
        );
        if (continuation.success && continuation.data.jobIds.includes(jobId)) {
          void continueAssistantArtifact(artifact.id);
        }
      }
    }
  };
  const continueArtifactsForAcquisitionJob = (jobId: string) => {
    for (const workspace of repository.listWorkspaces()) {
      for (const artifact of repository.listArtifacts(workspace.id, { limit: 1_000 })) {
        if (!continuableArtifactStatuses.has(artifact.status)) continue;
        const continuation = assistantArtifactContinuationSchema.safeParse(
          artifact.provenance.assistantContinuation,
        );
        if (continuation.success && continuation.data.enrichment?.jobId === jobId) {
          void continueAssistantArtifact(artifact.id);
        }
      }
    }
  };
  assistantDiscoveryListener = (job) => {
    if (terminalDiscoveryStatuses.has(job.status)) continueArtifactsForDiscoveryJob(job.id);
  };
  discovery.subscribe((job) => assistantDiscoveryListener?.(job));
  acquisition.subscribe((job) => {
    if (terminalAcquisitionStatuses.has(job.status)) continueArtifactsForAcquisitionJob(job.id);
  });
  queueMicrotask(() => {
    for (const workspace of repository.listWorkspaces()) {
      for (const artifact of repository.listArtifacts(workspace.id, { status: "queued", limit: 1_000 })) {
        if (assistantArtifactContinuationSchema.safeParse(artifact.provenance.assistantContinuation).success) {
          void continueAssistantArtifact(artifact.id);
        }
      }
    }
  });
  app.use("/api/*", cors({ origin: [
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:3001", "http://127.0.0.1:3001",
  ] }));

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
  app.get("/api/workspaces", (context) => context.json({ workspaces: repository.listWorkspaces() }));
  app.post("/api/workspaces", async (context) => {
    const parsed = workspaceCreateSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid workspace", issues: parsed.error.issues }, 400);
    try {
      return context.json(repository.createWorkspace(parsed.data), 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "workspace creation failed" }, 409);
    }
  });
  app.get("/api/workspaces/current/ui-schema", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const schema = workspaceUiSchema(repository, workspaceId);
    return schema ? context.json(schema) : context.json({ error: "workspace not found" }, 404);
  });
  app.post("/api/workspaces/:id/ui-schema/infer", async (context) => {
    const parsed = z.object({
      minCoverage: z.number().min(0).max(1).optional(),
      minObserved: z.number().int().positive().optional(),
      maxFacetCardinality: z.number().int().positive().optional(),
    }).safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) return context.json({ error: "invalid inference options", issues: parsed.error.issues }, 400);
    try {
      return context.json({ fields: repository.inferWorkspaceSchema(context.req.param("id"), parsed.data) });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "schema inference failed" }, 404);
    }
  });
  app.put("/api/workspaces/:id/ui-schema", async (context) => {
    const parsed = z.object({
      fields: z.array(fieldDefinitionInputSchema).max(200),
      replace: z.boolean().default(false),
    }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid field schema", issues: parsed.error.issues }, 400);
    try {
      const fields = repository.commitWorkspaceSchema(context.req.param("id"), parsed.data.fields, { replace: parsed.data.replace });
      return context.json({ fields });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "schema update failed" }, 409);
    }
  });
  app.get("/api/workspaces/:id", (context) => {
    const workspace = repository.getWorkspace(context.req.param("id"));
    return workspace ? context.json(workspace) : context.json({ error: "workspace not found" }, 404);
  });
  app.patch("/api/workspaces/:id", async (context) => {
    const parsed = workspaceUpdateSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid workspace update", issues: parsed.error.issues }, 400);
    const workspace = repository.updateWorkspace(context.req.param("id"), parsed.data);
    return workspace ? context.json(workspace) : context.json({ error: "workspace not found" }, 404);
  });
  app.delete("/api/workspaces/:id", (context) => {
    try {
      return repository.deleteWorkspace(context.req.param("id"))
        ? context.json({ deleted: true })
        : context.json({ error: "workspace cannot be deleted" }, 409);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "workspace deletion failed" }, 409);
    }
  });
  app.get("/api/embeddings/job", (context) => context.json(getEmbeddingJob()));
  app.post("/api/embeddings/job", (context) => context.json(startEmbeddingJob(repository), 202));
  app.get("/api/products", async (context) => {
    const search = context.req.query("search");
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const limit = Number(context.req.query("limit") ?? 1000);
    return context.json(await attachImageAspectRatios(projectCompactCached(
      repository.listProducts({ workspaceId, search, limit }),
      requestedProjectionMode(context.req.query("projection")),
    )));
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
    if (requested.protocol !== "https:" || !isPublicShopHostname(requested.hostname)) {
      return context.json({ error: "Only public HTTPS shop pages can be imported." }, 400);
    }
    const workspaceId = parsed.data.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    const result = await importPublicProductUrls([parsed.data.url], repository, context.req.raw.signal, { workspaceId });
    if (result.products.length) {
      repository.replaceCoordinates(projectCompactCached(repository.listProducts({ workspaceId, limit: 10_000 })));
      return context.json(result.products[0], 201);
    }
    return context.json({ error: result.errors[0]?.error ?? "product import failed" }, 422);
  });
  app.post("/api/products/import-urls", async (context) => {
    const parsed = z.object({
      urls: z.array(z.string().url().max(2_000)).min(1).max(24),
      workspaceId: z.string().trim().min(1).max(128).optional(),
    }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid product URLs", issues: parsed.error.issues }, 400);
    const workspaceId = parsed.data.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    const result = await importPublicProductUrls(parsed.data.urls, repository, context.req.raw.signal, { workspaceId });
    if (result.products.length) repository.replaceCoordinates(projectCompactCached(repository.listProducts({ workspaceId, limit: 10_000 })));
    return context.json(result, result.products.length ? 201 : 422);
  });
  app.post("/api/query", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const products = repository.listProducts({ workspaceId, filter, limit: filter.limit });
    return context.json(await attachImageAspectRatios(projectCompactCached(
      products,
      requestedProjectionMode(context.req.query("projection")),
    )));
  });
  app.post("/api/references", async (context) => {
    const parsed = referenceItemSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid reference", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    if (!repository.getWorkspace(input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID)) {
      return context.json({ error: "workspace not found" }, 404);
    }
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
      workspaceId: input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
      kind: "reference",
      source: "reference",
      sourceId,
      url: `https://reference.local/${sourceId}`,
      brand: "Référence",
      name: input.name,
      description: input.description ?? "",
      price: null,
      originalPrice: null,
      currency: "XXX",
      category: input.category ?? "Référence",
      color: input.color ?? "Unknown",
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
    return context.json(repository.getProduct(id, input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID), 201);
  });
  app.patch("/api/products/:id", async (context) => {
    const patch = productPatchSchema.parse(await context.req.json());
    const id = context.req.param("id");
    const requestedWorkspace = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const product = repository.getProduct(id, requestedWorkspace);
    if (!product) return context.json({ error: "product not found" }, 404);
    const workspaceId = product.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (patch.decision) {
      const result = repository.setDecision([id], patch.decision, workspaceId);
      const rest = { ...patch, decision: undefined };
      if (Object.values(rest).some((value) => value !== undefined)) {
        repository.patchProducts([id], rest, workspaceId);
      }
      return context.json({ updated: 1, product: repository.getProduct(id, workspaceId), actionId: result.actionId });
    }
    const updated = repository.patchProducts([id], patch, workspaceId);
    return context.json({ updated, product: repository.getProduct(id, workspaceId) });
  });
  app.post("/api/products/bulk-decision", async (context) => {
    const body = z.object({
      workspaceId: z.string().min(1).max(128).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      ids: z.array(z.string().min(1)).min(1).max(500),
      decision: decisionSchema,
    }).parse(await context.req.json());
    try {
      return context.json(repository.setDecision(body.ids, body.decision, body.workspaceId));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "bulk decision failed" }, 409);
    }
  });
  app.post("/api/actions/undo", async (context) => {
    const body = z.object({
      actionId: z.string().uuid().optional(),
      workspaceId: z.string().min(1).max(128).default(DEFAULT_CLOTHING_WORKSPACE_ID),
    }).parse(await context.req.json());
    const result = body.actionId
      ? repository.undoDecision(body.actionId, body.workspaceId)
      : repository.undoLastDecision(body.workspaceId);
    if (!result) return context.json({ error: "action not found or already undone" }, 409);
    return context.json({ ...result, product: result.products[0] ?? null });
  });

  app.post("/api/personal-items", async (context) => {
    const parsed = personalItemSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid personal item", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    const workspaceId = input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) {
      return context.json({ error: "workspace not found" }, 404);
    }
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
      workspaceId,
      kind: input.kind,
      source: input.kind,
      sourceId,
      url: `https://${input.kind}.local/${sourceId}`,
      brand: input.kind === "owned" ? "Mon dressing" : "Référence",
      name: input.name,
      description: input.description ?? "",
      price: null,
      originalPrice: null,
      currency: "XXX",
      category: input.category ?? (input.kind === "reference" ? "References" : "Other"),
      color: input.color ?? "Unknown",
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
    return context.json(repository.getProduct(id, workspaceId), 201);
  });
  app.get("/api/filters", (context) => context.json(repository.listFilters(
    context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
  )));
  app.post("/api/filters", async (context) => {
    const filter = filterSpecSchema.parse(await context.req.json());
    return context.json(repository.saveFilter(filter, context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID), 201);
  });
  app.get("/api/views", (context) => context.json(repository.listViews(
    context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
  )));
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
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : DEFAULT_CLOTHING_WORKSPACE_ID;
    try {
      return context.json(repository.saveView({ id, workspaceId, name, filter, state: body }), 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "view save failed" }, 409);
    }
  });
  app.get("/api/views/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const view = repository.getView(context.req.param("id"), workspaceId);
    return view ? context.json(view) : context.json({ error: "view not found" }, 404);
  });
  app.delete("/api/views/:id", (context) => repository.deleteView(
    context.req.param("id"),
    context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
  )
    ? context.json({ deleted: true })
    : context.json({ error: "view not found" }, 404));

  app.get("/api/collections", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const limit = boundedLimit(context.req.query("limit"), 100, 500);
    return context.json({ collections: repository.listCollections(workspaceId).slice(0, limit).map(collectionView) });
  });
  app.post("/api/collections", async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    const parsed = collectionCreateSchema.safeParse({
      ...body,
      workspaceId: body.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
      type: body.type ?? body.kind ?? "manual",
    });
    if (!parsed.success) return context.json({ error: "invalid collection", issues: parsed.error.issues }, 400);
    try {
      return context.json(collectionView(repository.createCollection(parsed.data)), 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "collection creation failed" }, 409);
    }
  });
  app.get("/api/collections/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const collection = repository.getCollection(context.req.param("id"), workspaceId);
    return collection ? context.json(collectionView(collection)) : context.json({ error: "collection not found" }, 404);
  });
  app.patch("/api/collections/:id", async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    const workspaceId = typeof body.workspaceId === "string"
      ? body.workspaceId
      : (context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID);
    const parsed = collectionUpdateSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid collection update", issues: parsed.error.issues }, 400);
    try {
      const collection = repository.updateCollection(context.req.param("id"), parsed.data, workspaceId);
      return collection ? context.json(collectionView(collection)) : context.json({ error: "collection not found" }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "collection update failed" }, 409);
    }
  });
  app.post("/api/collections/:id/items", async (context) => {
    const body = await context.req.json<{ workspaceId?: string; itemIds?: string[]; items?: unknown[] }>();
    const workspaceId = body.workspaceId ?? context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getCollection(context.req.param("id"), workspaceId)) {
      return context.json({ error: "collection not found" }, 404);
    }
    const rawItems = body.items ?? (body.itemIds ?? []).map((itemId) => ({ itemId }));
    const parsed = z.array(collectionItemInputSchema).min(1).max(500).safeParse(rawItems);
    if (!parsed.success) return context.json({ error: "invalid collection items", issues: parsed.error.issues }, 400);
    try {
      return context.json(collectionView(repository.addCollectionItems(context.req.param("id"), parsed.data, workspaceId)));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "collection update failed" }, 409);
    }
  });
  app.delete("/api/collections/:id/items", async (context) => {
    const parsed = z.object({
      workspaceId: z.string().min(1).optional(),
      itemIds: z.array(z.string().min(1)).min(1).max(500),
    }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid collection items", issues: parsed.error.issues }, 400);
    const workspaceId = parsed.data.workspaceId ?? context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getCollection(context.req.param("id"), workspaceId)) {
      return context.json({ error: "collection not found" }, 404);
    }
    try {
      return context.json(collectionView(repository.removeCollectionItems(
        context.req.param("id"),
        parsed.data.itemIds,
        workspaceId,
      )));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "collection update failed" }, 409);
    }
  });
  app.delete("/api/collections/:id", (context) => repository.deleteCollection(
    context.req.param("id"),
    context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
  )
    ? context.json({ deleted: true })
    : context.json({ error: "collection not found or protected" }, 409));

  app.get("/api/artifacts", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    return context.json({ artifacts: repository.listArtifacts(workspaceId, { limit: boundedLimit(context.req.query("limit"), 100) }) });
  });
  app.post("/api/artifacts", async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    const parsedImages = artifactRequestImagesSchema.safeParse(body.images);
    if (!parsedImages.success) return context.json({ error: "invalid artifact images", issues: parsedImages.error.issues }, 400);
    const parsed = artifactCreateSchema.safeParse({
      ...body,
      id: undefined,
      localFiles: [],
      workspaceId: body.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    });
    if (!parsed.success) return context.json({ error: "invalid artifact", issues: parsed.error.issues }, 400);
    try {
      const input = { ...parsed.data };
      delete input.id;
      delete input.localFiles;
      return context.json(await createArtifactWithLocalImages(repository, input, parsedImages.data), 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "artifact creation failed" }, 409);
    }
  });
  app.patch("/api/artifacts/:id", async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    const workspaceId = typeof body.workspaceId === "string"
      ? body.workspaceId
      : (context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID);
    const publicPatch = { ...body };
    delete publicPatch.workspaceId;
    const parsed = artifactPublicUpdateSchema.safeParse(publicPatch);
    if (!parsed.success) return context.json({ error: "invalid artifact update", issues: parsed.error.issues }, 400);
    try {
      const artifact = repository.updateArtifact(context.req.param("id"), parsed.data, workspaceId);
      return artifact ? context.json(artifact) : context.json({ error: "artifact not found" }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "artifact update failed" }, 409);
    }
  });
  app.get("/api/artifacts/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const artifact = repository.getArtifact(context.req.param("id"), workspaceId);
    return artifact ? context.json(artifact) : context.json({ error: "artifact not found" }, 404);
  });
  app.delete("/api/artifacts/:id", async (context) => {
    const id = context.req.param("id");
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.deleteArtifact(id, workspaceId)) return context.json({ error: "artifact not found" }, 404);
    await deleteCatalogMedia(`artifact-${id}`).catch(() => undefined);
    return context.json({ deleted: true });
  });

  app.get("/api/assistant/conversations", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    return context.json({
      conversations: repository.listAssistantConversations(
        workspaceId,
        boundedLimit(context.req.query("limit"), 30, 200),
      ),
    });
  });

  app.post("/api/assistant/conversations", async (context) => {
    const parsed = z.object({
      workspaceId: z.string().trim().min(1).max(128),
      title: z.string().trim().min(1).max(160).optional(),
    }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid conversation", issues: parsed.error.issues }, 400);
    try {
      return context.json({ conversation: repository.createAssistantConversation(parsed.data) }, 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "conversation creation failed" }, 409);
    }
  });

  app.get("/api/assistant/conversations/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const conversation = repository.getAssistantConversation(context.req.param("id"), workspaceId);
    if (!conversation) return context.json({ error: "conversation not found" }, 404);
    return context.json({
      conversation,
      messages: repository.listAssistantMessages(
        conversation.id,
        workspaceId,
        boundedLimit(context.req.query("limit"), 100, 500),
      ),
    });
  });

  app.patch("/api/assistant/conversations/:id", async (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const parsed = z.object({ title: z.string().trim().min(1).max(160) }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid conversation update", issues: parsed.error.issues }, 400);
    const conversation = repository.updateAssistantConversation(context.req.param("id"), parsed.data, workspaceId);
    return conversation ? context.json({ conversation }) : context.json({ error: "conversation not found" }, 404);
  });

  app.delete("/api/assistant/conversations/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const messages = repository.listAssistantMessages(context.req.param("id"), workspaceId, 500);
    if (messages.some((message) => {
      if (!message.researchRunId) return false;
      const run = research.get(message.researchRunId, workspaceId);
      return run?.status === "queued" || run?.status === "running";
    })) return context.json({ error: "cancel active research before deleting this conversation" }, 409);
    return repository.deleteAssistantConversation(context.req.param("id"), workspaceId)
      ? context.json({ deleted: true })
      : context.json({ error: "conversation not found" }, 404);
  });

  app.post("/api/research/runs", async (context) => {
    const parsed = researchApiRequestSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid research request", issues: parsed.error.issues }, 400);
    if (!parsed.data.prompt && !parsed.data.itemIds.length && !parsed.data.collectionIds.length
      && !parsed.data.images.length && !parsed.data.urls.length) {
      return context.json({ error: "a prompt or at least one input is required" }, 400);
    }
    if (!repository.getWorkspace(parsed.data.workspaceId)) return context.json({ error: "workspace not found" }, 404);
    const mediaId = `research-${crypto.randomUUID()}`;
    try {
      const stored = parsed.data.images.length
        ? await persistCatalogImages(mediaId, parsed.data.images.map((image) => image.dataUrl))
        : [];
      const run = research.start({
        ...parsed.data,
        images: stored.map((mediaPath, index) => ({
          name: parsed.data.images[index]?.name || `reference-${index + 1}`,
          mediaPath,
          mimeType: mediaPath.endsWith(".png")
            ? "image/png"
            : mediaPath.endsWith(".webp") ? "image/webp" : "image/jpeg",
        })),
      });
      return context.json({ run }, 202);
    } catch (error) {
      await deleteCatalogMedia(mediaId).catch(() => undefined);
      return context.json({ error: error instanceof Error ? error.message : "research could not start" }, 409);
    }
  });

  app.get("/api/research/runs", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    return context.json({ runs: research.list(workspaceId, boundedLimit(context.req.query("limit"), 50, 200)) });
  });

  app.get("/api/research/runs/:id", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const run = research.get(context.req.param("id"), workspaceId);
    if (!run) return context.json({ error: "research run not found" }, 404);
    const afterSequence = Number(context.req.query("afterSequence") ?? 0);
    const includeEvents = context.req.query("events") === "1" || Number.isFinite(afterSequence) && afterSequence > 0;
    return context.json({
      run,
      ...(includeEvents ? {
        events: research.events(run.id, workspaceId, {
          afterSequence: Number.isFinite(afterSequence) ? Math.max(0, Math.trunc(afterSequence)) : 0,
          limit: boundedLimit(context.req.query("eventLimit"), 200, 1_000),
        }),
      } : {}),
    });
  });

  app.get("/api/research/runs/:id/events", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!research.get(context.req.param("id"), workspaceId)) return context.json({ error: "research run not found" }, 404);
    const rawAfter = Number(context.req.query("afterSequence") ?? 0);
    return context.json({
      events: research.events(context.req.param("id"), workspaceId, {
        afterSequence: Number.isFinite(rawAfter) ? Math.max(0, Math.trunc(rawAfter)) : 0,
        limit: boundedLimit(context.req.query("limit"), 200, 1_000),
      }),
    });
  });

  app.post("/api/research/runs/:id/cancel", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const run = research.cancel(context.req.param("id"), workspaceId);
    return run ? context.json({ run }) : context.json({ error: "research run not found" }, 404);
  });

  app.post("/api/research/runs/:id/resume", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    try {
      return context.json({ run: research.resume(context.req.param("id"), workspaceId) }, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "research run could not resume" }, 409);
    }
  });

  app.delete("/api/research/runs/:id", async (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    try {
      const run = research.delete(context.req.param("id"), workspaceId);
      if (!run) return context.json({ error: "research run not found" }, 404);
      const mediaIds = new Set(run.request.images.flatMap((image) => {
        const match = /^\/api\/media\/([^/?#]+)\/[1-6]\.(?:jpg|png|webp)$/.exec(image.mediaPath);
        if (!match) return [];
        try { return [decodeURIComponent(match[1]!)]; } catch { return []; }
      }));
      await Promise.all([...mediaIds].map((mediaId) => deleteCatalogMedia(mediaId).catch(() => undefined)));
      return context.json({ deleted: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "research run could not be deleted" }, 409);
    }
  });

  app.get("/api/runs", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const limit = boundedLimit(context.req.query("limit"), 50, 200);
    const runs: RunView[] = [];
    for (const job of listDiscoveryJobs(limit)) {
      const jobWorkspace = (job.intent as DiscoveryIntent & { workspaceId?: string }).workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
      if (jobWorkspace !== workspaceId) continue;
      runs.push({
        id: job.id, workspaceId, kind: "discovery", title: job.intent.query || job.intent.category || "Découverte web",
        source: job.source, status: job.status, progress: job.progress, total: job.total,
        completed: job.completed, succeeded: job.discovered, failed: job.failed, blocked: job.blocked,
        cancelled: job.cancelled, message: job.error ?? `${job.discovered} éléments trouvés`, error: job.error ?? null,
        canCancel: job.status === "queued" || job.status === "running",
        canResume: job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "blocked",
        plan: job.intent as unknown as RunView["plan"], metadata: { duplicates: job.duplicates, filtered: job.filtered },
        createdAt: job.createdAt, startedAt: job.startedAt ?? null, updatedAt: job.updatedAt, finishedAt: job.finishedAt ?? null,
      });
    }
    for (const job of acquisition.list(workspaceId).slice(0, limit)) {
      runs.push({
        id: job.id, workspaceId: job.workspaceId, kind: "enrichment", title: "Vérification des fiches", source: job.source,
        status: job.status, progress: job.progress, total: job.total, completed: job.completed,
        succeeded: job.succeeded, failed: job.failed, blocked: job.blocked, cancelled: job.cancelled,
        message: job.error ?? `${job.completed}/${job.total} vérifiées`, error: job.error ?? null,
        canCancel: job.status === "queued" || job.status === "running",
        canResume: job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "blocked",
        plan: {}, metadata: {}, createdAt: job.createdAt, startedAt: job.startedAt ?? null,
        updatedAt: job.updatedAt, finishedAt: job.finishedAt ?? null,
      });
    }
    for (const run of research.list(workspaceId, limit)) {
      const terminal = ["succeeded", "partial", "needs_input", "failed", "blocked", "cancelled"].includes(run.status);
      const completed = Math.min(run.eventCount, run.request.budget.maxToolCalls);
      runs.push({
        id: run.id,
        workspaceId: run.workspaceId,
        kind: "research",
        title: (run.result?.title ?? run.request.prompt.slice(0, 120)) || "AI research",
        source: run.model,
        status: run.status,
        progress: terminal ? 1 : Math.min(.95, completed / run.request.budget.maxToolCalls),
        total: run.request.budget.maxToolCalls,
        completed,
        succeeded: run.result?.itemIds.length ?? 0,
        failed: run.status === "failed" ? 1 : 0,
        blocked: run.status === "blocked" ? 1 : 0,
        cancelled: run.status === "cancelled" ? 1 : 0,
        message: run.message,
        error: run.error,
        canCancel: run.status === "queued" || run.status === "running",
        canResume: ["failed", "blocked", "interrupted", "needs_input"].includes(run.status),
        plan: run.request as unknown as RunView["plan"],
        metadata: (run.result as unknown as RunView["metadata"] | null) ?? {},
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt,
      });
    }
    for (const job of repository.listVisualJobs(limit, workspaceId)) {
      const status = job.status === "complete" ? "succeeded" : job.status === "error" ? "failed" : "running";
      runs.push({
        id: job.id, workspaceId: job.workspaceId, kind: "visual-scoring", title: job.prompt.slice(0, 120), source: "codex-luna",
        status, progress: job.candidateCount ? Math.min(1, job.inspected / job.candidateCount) : 0,
        total: job.candidateCount, completed: job.inspected, succeeded: job.selected,
        failed: status === "failed" ? 1 : 0, blocked: 0, cancelled: 0,
        message: job.message, error: job.error ?? null, canCancel: false, canResume: false,
        plan: job.constraints as RunView["plan"], metadata: { analysisMode: job.analysisMode },
        createdAt: job.createdAt, startedAt: job.createdAt, updatedAt: job.updatedAt,
        finishedAt: status === "running" ? null : job.updatedAt,
      });
    }
    for (const artifact of repository.listArtifacts(workspaceId, { limit })) {
      if (artifact.status === "draft") continue;
      runs.push({
        id: artifact.id, workspaceId, kind: "generation", title: artifact.name, source: artifact.generator,
        status: artifact.status, progress: artifact.status === "succeeded" ? 1 : 0,
        total: 1, completed: artifact.status === "succeeded" ? 1 : 0, succeeded: artifact.status === "succeeded" ? 1 : 0,
        failed: artifact.status === "failed" ? 1 : 0, blocked: artifact.status === "blocked" ? 1 : 0,
        cancelled: artifact.status === "cancelled" ? 1 : 0, message: artifact.error ?? artifact.prompt,
        error: artifact.error, canCancel: artifact.status === "queued" || artifact.status === "running", canResume: false,
        plan: {}, metadata: artifact.provenance, createdAt: artifact.createdAt, startedAt: null,
        updatedAt: artifact.updatedAt, finishedAt: artifact.finishedAt,
      });
    }
    const embedding = getEmbeddingJob();
    if (workspaceId === DEFAULT_CLOTHING_WORKSPACE_ID && embedding.status !== "idle") {
      const timestamp = embedding.finishedAt ?? embedding.startedAt ?? new Date().toISOString();
      runs.push({
        id: "visual-embeddings-current", workspaceId, kind: "embedding", title: "Index visuel local CLIP", source: "local",
        status: embedding.status, progress: embedding.total ? Math.min(1, embedding.processed / embedding.total) : 0,
        total: embedding.total, completed: embedding.processed, succeeded: embedding.summary?.embedded ?? 0,
        failed: embedding.summary?.errors ?? (embedding.status === "failed" ? 1 : 0), blocked: 0, cancelled: 0,
        message: embedding.message ?? "Index visuel", error: embedding.status === "failed" ? embedding.message ?? "Embedding failed" : null,
        canCancel: false, canResume: false, plan: {}, metadata: embedding.summary ?? {},
        createdAt: embedding.startedAt ?? timestamp, startedAt: embedding.startedAt ?? null,
        updatedAt: timestamp, finishedAt: embedding.finishedAt ?? null,
      });
    }
    return context.json({ runs: runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit) });
  });

  app.get("/api/discovery/jobs", (context) => {
    const requestedLimit = Number(context.req.query("limit") ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 20;
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    return context.json(listDiscoveryJobs(limit).filter((job) => (
      (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) === workspaceId
    )));
  });
  app.post("/api/discovery/jobs", async (context) => {
    const body = await context.req.json<{ workspaceId?: string; intent?: DiscoveryIntent; intents?: DiscoveryIntent[] }>();
    const workspaceId = body.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    const intents = (body.intents ?? (body.intent ? [body.intent] : [])).map((intent) => ({ ...intent, workspaceId }));
    try {
      const jobs = startDiscoveryIntents(intents);
      return context.json({ jobs }, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "discovery unavailable" }, 400);
    }
  });
  app.get("/api/discovery/jobs/:id", (context) => {
    const job = discoveryForJob(context.req.param("id")).get(context.req.param("id"));
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (job && (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) !== workspaceId) {
      return context.json({ error: "discovery job not found" }, 404);
    }
    return job ? context.json(job) : context.json({ error: "discovery job not found" }, 404);
  });
  app.post("/api/discovery/jobs/:id/cancel", (context) => {
    const id = context.req.param("id");
    const service = discoveryForJob(id);
    const job = service.get(id);
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!job || (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) !== workspaceId) {
      return context.json({ error: "discovery job not found" }, 404);
    }
    try { return context.json(service.cancel(id)); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "cancel failed" }, 404); }
  });
  app.post("/api/discovery/jobs/:id/retry", (context) => {
    const id = context.req.param("id");
    const service = discoveryForJob(id);
    const job = service.get(id);
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!job || (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) !== workspaceId) {
      return context.json({ error: "discovery job not found" }, 404);
    }
    const interactive = context.req.query("interactive") === "1";
    if (interactive) interactiveDiscoveryJobs.add(id);
    try { return context.json(service.retry(id), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "retry failed" }, 409); }
  });
  app.post("/api/discovery/jobs/:id/resume", (context) => {
    const id = context.req.param("id");
    const service = discoveryForJob(id);
    const job = service.get(id);
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!job || (job.intent.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID) !== workspaceId) {
      return context.json({ error: "discovery job not found" }, 404);
    }
    const interactive = context.req.query("interactive") === "1";
    if (interactive) interactiveDiscoveryJobs.add(id);
    try { return context.json(service.resume(id), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "resume failed" }, 409); }
  });

  app.get("/api/acquisition/jobs", (context) => {
    const requestedLimit = Number(context.req.query("limit") ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 20;
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    return context.json(acquisition.list(workspaceId).slice(0, limit).map(acquisitionClientView));
  });
  app.post("/api/acquisition/jobs", async (context) => {
    const body = z.object({
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      productIds: z.array(z.string().min(1)).min(1).max(120),
    }).parse(await context.req.json());
    const products = body.productIds.map((id) => repository.getProduct(id, body.workspaceId));
    if (products.some((product) => !product)) {
      return context.json({ error: "unknown or cross-workspace product" }, 400);
    }
    const seenUrls = new Set<string>();
    const targets = products.flatMap((product) => {
      if (product?.kind !== "shop" || seenUrls.has(product.url)) return [];
      seenUrls.add(product.url);
      return [{ productId: product.id, url: product.url }];
    });
    if (!targets.length) return context.json({ error: "no refreshable shop products" }, 400);
    try { return context.json(acquisitionClientView(acquisition.start({ targets, workspaceId: body.workspaceId })), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "acquisition unavailable" }, 400); }
  });
  app.post("/api/acquisition/jobs/unknown-sizes", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const garmentCategories = new Set(["Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts"]);
    const freshAfter = Date.now() - 48 * 60 * 60 * 1_000;
    const seenUrls = new Set<string>();
    const targets = repository.listProducts({ workspaceId, limit: 10_000 })
      .filter((product) => product.kind === "shop" && product.source === "zalando-ch"
        && product.decision !== "owned" && product.decision !== "rejected" && garmentCategories.has(product.category))
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
      .slice(0, 1_000);
    if (!targets.length) return context.json({ error: "no garment needs a size refresh" }, 400);
    try { return context.json(acquisitionClientView(acquisition.start({ targets, workspaceId, source: "size-enrichment" })), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "size acquisition unavailable" }, 400); }
  });
  app.get("/api/acquisition/jobs/:id", (context) => {
    const job = acquisition.get(context.req.param("id"));
    if (!job) return context.json({ error: "acquisition job not found" }, 404);
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (job.workspaceId !== workspaceId) return context.json({ error: "acquisition job not found" }, 404);
    return context.json(acquisitionClientView(job));
  });
  app.post("/api/acquisition/jobs/:id/retry", (context) => {
    const id = context.req.param("id");
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const job = acquisition.get(id);
    if (!job || job.workspaceId !== workspaceId) return context.json({ error: "acquisition job not found" }, 404);
    try { return context.json(acquisitionClientView(acquisition.retry(id)), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "retry failed" }, 409); }
  });
  app.post("/api/acquisition/jobs/:id/resume", (context) => {
    const id = context.req.param("id");
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const job = acquisition.get(id);
    if (!job || job.workspaceId !== workspaceId) return context.json({ error: "acquisition job not found" }, 404);
    try { return context.json(acquisitionClientView(acquisition.resume(id)), 202); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "resume failed" }, 409); }
  });
  app.post("/api/acquisition/jobs/:id/cancel", (context) => {
    const id = context.req.param("id");
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    const job = acquisition.get(id);
    if (!job || job.workspaceId !== workspaceId) return context.json({ error: "acquisition job not found" }, 404);
    try { return context.json(acquisitionClientView(acquisition.cancel(id))); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : "cancel failed" }, 404); }
  });

  app.get("/api/outfit-boards", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    return context.json(repository.listOutfitBoards(workspaceId).map(outfitView));
  });
  app.post("/api/outfit-boards", async (context) => {
    const body = z.object({
      id: z.string().min(1).optional(),
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2000).optional(),
      productIds: z.array(z.string().min(1)).min(1).max(20),
    }).parse(await context.req.json());
    if (body.productIds.some((id) => !repository.getProduct(id, body.workspaceId))) {
      return context.json({ error: "unknown or cross-workspace outfit item" }, 400);
    }
    const board = repository.saveOutfitBoard({
      id: body.id ?? crypto.randomUUID(),
      workspaceId: body.workspaceId,
      name: body.name,
      description: body.description,
      items: [...new Set(body.productIds)].map((productId, position) => ({ productId, position })),
    });
    return context.json(outfitView(board), 201);
  });
  app.post("/api/outfit-boards/generate", async (context) => {
    const body = z.object({
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      anchorProductId: z.string().min(1),
      maxOutfits: z.number().int().min(1).max(3).default(3),
    }).parse(await context.req.json());
    const anchor = repository.getProduct(body.anchorProductId, body.workspaceId);
    if (!anchor) return context.json({ error: "anchor product not found" }, 404);
    const generated = generateOutfits(anchor, repository.listProducts({ workspaceId: body.workspaceId, limit: 10_000 }), body.maxOutfits);
    const boards = generated.map((outfit) => repository.saveOutfitBoard({
      id: crypto.randomUUID(),
      workspaceId: body.workspaceId,
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
  app.delete("/api/outfit-boards/:id", (context) => repository.deleteOutfitBoard(
    context.req.param("id"),
    context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
  )
    ? context.json({ deleted: true })
    : context.json({ error: "outfit board not found" }, 404));

  app.get("/api/export", (context) => {
    const workspaceId = context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    return context.json({
      exportedAt: new Date().toISOString(),
      workspace: repository.getWorkspace(workspaceId),
      products: repository.listProducts({ workspaceId, limit: 10_000 }),
      views: repository.listViews(workspaceId),
      collections: repository.listCollections(workspaceId).map(collectionView),
      artifacts: repository.listArtifacts(workspaceId, { limit: 1_000 }),
      outfits: repository.listOutfitBoards(workspaceId).map(outfitView),
    });
  });
  app.post("/api/similar", async (context) => {
    const body = z.object({
      workspaceId: z.string().min(1).default(DEFAULT_CLOTHING_WORKSPACE_ID),
      productIds: z.array(z.string().min(1)).min(1).max(12),
      limit: z.number().int().min(1).max(100).default(30),
      constraints: visualConstraintsSchema.optional(),
    }).parse(await context.req.json());
    const products = await findSimilarProducts({
      productIds: body.productIds,
      limit: body.limit,
      constraints: { workspaceId: body.workspaceId, ...(body.constraints ?? {}) },
    }, repository);
    return context.json(await attachImageAspectRatios(projectCompactCached(products)));
  });
  app.post("/api/codex/ask", async (context) => {
    const parsed = assistantRequestSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid assistant request", issues: parsed.error.issues }, 400);
    const body = parsed.data;
    const workspace = repository.getWorkspace(body.workspaceId);
    if (!workspace) return context.json({ error: "workspace not found" }, 404);
    const links = assistantLinks(body.prompt);
    const selectedCollections = body.collectionIds.map((id) => repository.getCollection(id));
    if (selectedCollections.some((collection) => !collection || collection.workspaceId !== body.workspaceId)) {
      return context.json({ error: "unknown or cross-workspace collection" }, 400);
    }
    const selectedItemIds = [...new Set([
      ...body.productIds,
      ...selectedCollections.flatMap((collection) => collection?.items.map((item) => item.itemId) ?? []),
    ])].slice(0, 160);
    const attachedProducts = selectedItemIds
      .map((id) => repository.getProduct(id, body.workspaceId))
      .filter(Boolean);
    if (body.productIds.some((id) => !attachedProducts.some((product) => product!.id === id))) {
      return context.json({ error: "unknown or cross-workspace product" }, 400);
    }
    if (!body.prompt && !body.images.length && !attachedProducts.length && !selectedCollections.length) {
      return context.json({ error: "prompt or attachments are required" }, 400);
    }
    try {
      const plan = await (options.assistantPlanner ?? createAssistantPlanWithCodex)({
        prompt: body.prompt,
        imageCount: body.images.length,
        productIds: attachedProducts.map((product) => product!.id),
        collectionIds: body.collectionIds,
        workspaceProfile: workspace.profile,
        links,
        defaults: {
          sizes: workspace.profile === "clothing" ? body.constraints.sizes ?? [] : [],
          shops: body.constraints.shops?.length ? body.constraints.shops : ["zalando-ch", "aboutyou-ch", "aliexpress"],
          minPrice: body.constraints.minPrice,
          maxPrice: body.constraints.maxPrice,
        },
      });
      const primaryStep = plan.steps.find((step) => step.id === plan.primaryStepId)!;
      const upstreamSteps = assistantUpstreamSteps(plan, primaryStep.id);
      const allowedUpstreamTypes = primaryStep.type === "artifact"
        ? new Set<AssistantStep["type"]>(["import_urls", "discover_adapter", "enrich"])
        : new Set<AssistantStep["type"]>(["import_urls"]);
      const unsupportedUpstream = upstreamSteps.filter((step) => !allowedUpstreamTypes.has(step.type));
      if (unsupportedUpstream.length) {
        return context.json({
          plan,
          workspace,
          imported: [],
          importErrors: [],
          selectedCollectionIds: body.collectionIds,
          action: "clarify",
          message: primaryStep.type === "artifact"
            ? `Ce pipeline d’artefact n’est pas lancé: l’étape « ${unsupportedUpstream[0]!.title} » n’a pas encore de reprise automatique. Lance d’abord cette étape, puis crée l’artefact depuis sa sélection.`
            : `Cette chaîne n’est pas lancée automatiquement après une découverte ou un enrichissement. Termine d’abord « ${unsupportedUpstream[0]!.title} », puis relance « ${primaryStep.title} » sur les résultats enregistrés.`,
        }, 400);
      }
      const outOfPhaseDiscovery = upstreamSteps
        .filter((step): step is AssistantDiscoverStep => step.type === "discover_adapter")
        .find((step) => assistantUpstreamSteps(plan, step.id).some(
          (dependency) => dependency.type === "discover_adapter" || dependency.type === "enrich",
        ));
      if (outOfPhaseDiscovery) {
        return context.json({
          plan,
          workspace,
          imported: [],
          importErrors: [],
          selectedCollectionIds: body.collectionIds,
          action: "clarify",
          message: `Le plan n’est pas lancé: « ${outOfPhaseDiscovery.title} » dépend d’une autre étape distante. Les découvertes automatiques doivent être indépendantes, avant un enrichissement commun.`,
        }, 400);
      }
      const imported = links.length
        ? await importPublicProductUrls(links, repository, context.req.raw.signal, { workspaceId: body.workspaceId })
        : { products: [], errors: [] };
      if (imported.products.length) repository.replaceCoordinates(projectCompactCached(repository.listProducts({ workspaceId: body.workspaceId, limit: 10_000 })));
      const anchorIds = [...new Set([
        ...attachedProducts.map((product) => product!.id),
        ...imported.products.map((product) => product.id),
      ])];
      const sourceIds = [...new Set(plan.effectiveShops.map(assistantShopId).filter(Boolean))] as DiscoveryIntent["source"][];
      const dynamicWhere = assistantFieldsWhere(body.constraints.fields);
      const hardWhere = assistantHardWhere({
        sources: plan.shopPolicy === "all" ? undefined : sourceIds.length ? sourceIds : undefined,
        categories: body.constraints.categories?.length ? body.constraints.categories : undefined,
        sizes: plan.effectiveSizes.length ? plan.effectiveSizes : undefined,
        minPrice: plan.effectiveMinPrice,
        maxPrice: plan.effectiveMaxPrice,
        includeRejected: body.constraints.includeRejected ?? false,
        dynamicWhere,
      });
      const constraints = {
        workspaceId: body.workspaceId,
        contextIds: anchorIds,
        sizes: plan.effectiveSizes.length ? plan.effectiveSizes : undefined,
        freshWithinHours: plan.effectiveSizes.length ? 48 : undefined,
        sources: plan.shopPolicy === "all" ? undefined : sourceIds.length ? sourceIds : undefined,
        categories: body.constraints.categories?.length ? body.constraints.categories : undefined,
        where: dynamicWhere,
        minPrice: plan.effectiveMinPrice,
        maxPrice: plan.effectiveMaxPrice,
        includeRejected: body.constraints.includeRejected ?? false,
      };
      const base = {
        plan,
        workspace,
        imported: imported.products,
        importErrors: imported.errors,
        selectedCollectionIds: body.collectionIds,
      };

      const launchAssistantDiscoveries = async (steps: AssistantDiscoverStep[]) => {
        const planned = await Promise.all(steps.map(async (step) => ({
          step,
          plan: await assistantDiscoveryPlan(step, plan),
        })));
        const prepared = planned.map(({ step, plan: discoveryPlan }) => {
          const stepSources = [...new Set(step.sources.map(assistantShopId).filter(Boolean))] as DiscoveryIntent["source"][];
          const allowedSources = plan.shopPolicy === "all" && !stepSources.length && !sourceIds.length
            ? null
            : new Set(stepSources.length ? stepSources : sourceIds);
          return {
            step,
            discoveryPlan,
            searches: discoveryPlan.searches.filter((search) => !allowedSources || allowedSources.has(search.source)),
          };
        });
        const unavailable = prepared.find(({ searches }) => !searches.length);
        if (unavailable) {
          return { error: `Aucune recherche exécutable n’a été produite pour « ${unavailable.step.title} ».` } as const;
        }
        const searches = prepared.flatMap((entry) => entry.searches);
        if (searches.length > 10) {
          return { error: `Le plan demande ${searches.length} jobs de découverte; la limite durable est de 10. Réduis les sources ou le nombre de recherches.` } as const;
        }
        const intents: DiscoveryIntent[] = searches.map((search) => ({
          source: search.source,
          workspaceId: body.workspaceId,
          query: search.query,
          category: search.category,
          maxItems: search.maxItems,
          sizeMode: "any",
          ...(planSearchUsesGarmentSizes(search) && plan.effectiveSizes.length ? { sizes: plan.effectiveSizes } : {}),
          ...(plan.effectiveMinPrice !== undefined ? { minPrice: plan.effectiveMinPrice } : search.minPrice > 0 ? { minPrice: search.minPrice } : {}),
          ...(plan.effectiveMaxPrice !== undefined ? { maxPrice: plan.effectiveMaxPrice } : search.maxPrice > 0 ? { maxPrice: search.maxPrice } : {}),
        }));
        const discoveryPlan: AssistantDiscoveryPlanView = prepared.length === 1
          ? { ...prepared[0]!.discoveryPlan, searches }
          : {
              id: crypto.randomUUID(),
              name: plan.title,
              description: `${prepared.length} étapes de découverte bornées, préparées avant lancement.`,
              targetCount: searches.reduce((sum, search) => sum + search.maxItems, 0),
              sizes: plan.effectiveSizes,
              sizeMode: "any",
              model: prepared.every((entry) => entry.discoveryPlan.model === prepared[0]!.discoveryPlan.model)
                ? prepared[0]!.discoveryPlan.model
                : "mixed",
              searches,
            };
        return { discoveryPlan, jobs: startDiscoveryIntents(intents) } as const;
      };

      const upstreamDiscoveries = upstreamSteps.filter(
        (step): step is AssistantDiscoverStep => step.type === "discover_adapter",
      );
      const upstreamEnrichments = upstreamSteps.filter(
        (step): step is AssistantEnrichStep => step.type === "enrich",
      );
      if (primaryStep.type === "artifact" && (upstreamDiscoveries.length || upstreamEnrichments.length)) {
        const launched = upstreamDiscoveries.length
          ? await launchAssistantDiscoveries(upstreamDiscoveries)
          : null;
        if (launched && "error" in launched) {
          return context.json({ ...base, action: "clarify", message: launched.error }, 400);
        }
        const generationRequested = primaryStep.mode === "generate";
        const initialItemIds = primaryStep.scope === "previous_step" ? [] : anchorIds;
        const continuation: AssistantArtifactContinuation = {
          version: 2,
          kind: "assistant-to-artifact",
          workspaceId: body.workspaceId,
          jobIds: launched?.jobs.map((job) => job.id) ?? [],
          seedProductIds: anchorIds.slice(0, 160),
          targetCount: primaryStep.targetCount,
          generationRequested,
          ...(upstreamEnrichments.length ? {
            enrichment: {
              stepIds: upstreamEnrichments.map((step) => step.id),
              fields: [...new Set(upstreamEnrichments.flatMap((step) => step.fields))],
              targetCount: Math.max(...upstreamEnrichments.map((step) => step.targetCount)),
              productIds: [],
              status: "planned" as const,
            },
          } : {}),
          status: upstreamDiscoveries.length ? "discovering" : "queued",
          createdAt: new Date().toISOString(),
        };
        const artifact = await createArtifactWithLocalImages(repository, {
          workspaceId: body.workspaceId,
          type: assistantArtifactType(primaryStep),
          name: plan.title,
          status: "queued",
          prompt: primaryStep.prompt || body.prompt,
          inputItemIds: initialItemIds.slice(0, primaryStep.targetCount),
          inputCollectionIds: body.collectionIds,
          generator: null,
          error: null,
          provenance: {
            planVersion: plan.version,
            primaryStepId: primaryStep.id,
            privacy: "local-first",
            discoveryJobIds: continuation.jobIds,
            pipelineStepIds: [...upstreamSteps.map((step) => step.id), primaryStep.id],
            assistantContinuation: continuation,
          },
        }, body.images);
        void continueAssistantArtifact(artifact.id);
        return context.json({
          ...base,
          action: "artifact",
          artifact,
          ...(launched ? { discoveryPlan: launched.discoveryPlan, jobs: launched.jobs } : { jobs: [] }),
          continuation: {
            id: artifact.id,
            kind: continuation.kind,
            status: "queued",
            artifactId: artifact.id,
            jobIds: continuation.jobIds,
          },
          message: upstreamDiscoveries.length
            ? "Découverte lancée; l’enrichissement éventuel et le brouillon reprendront automatiquement avec les produits réellement importés."
            : "Enrichissement lancé; le brouillon sera finalisé uniquement avec les produits réellement vérifiés.",
        }, 202);
      }

      if (primaryStep.type === "artifact") {
        const generationRequested = primaryStep.mode === "generate";
        const artifact = await createArtifactWithLocalImages(repository, {
          workspaceId: body.workspaceId,
          type: assistantArtifactType(primaryStep),
          name: plan.title,
          status: generationRequested ? "blocked" : "draft",
          prompt: primaryStep.prompt || body.prompt,
          inputItemIds: anchorIds.slice(0, primaryStep.targetCount),
          inputCollectionIds: body.collectionIds,
          generator: generationRequested ? "not-configured" : null,
          error: generationRequested
            ? "Aucun fournisseur de génération n’est configuré. Le brouillon et ses sources ont été conservés localement."
            : null,
          provenance: { planVersion: plan.version, primaryStepId: primaryStep.id, privacy: "local-first" },
        }, body.images);
        return context.json({
          ...base,
          action: "artifact",
          artifact,
          message: artifact.error ?? "Brouillon Studio créé.",
        }, 201);
      }
      if (primaryStep.type === "collection_operation") {
        const scopedIds = [...new Set(primaryStep.itemIds.length ? primaryStep.itemIds : anchorIds)]
          .filter((id) => Boolean(repository.getProduct(id, body.workspaceId)))
          .slice(0, primaryStep.targetCount);
        if (primaryStep.operation === "create") {
          let collection = repository.createCollection({
            workspaceId: body.workspaceId,
            type: "manual",
            name: primaryStep.name || plan.title,
            description: body.prompt,
            color: "#df705f",
            icon: "sparkles",
          });
          if (scopedIds.length) collection = repository.addCollectionItems(collection.id, scopedIds.map((itemId) => ({ itemId })));
          return context.json({ ...base, action: "collection", collection: collectionView(collection) }, 201);
        }
        const collectionId = primaryStep.collectionIds[0] ?? body.collectionIds[0];
        if (!collectionId) return context.json({ ...base, action: "clarify", message: "Choisis la collection à modifier." }, 400);
        const collection = repository.getCollection(collectionId);
        if (!collection || collection.workspaceId !== body.workspaceId) {
          return context.json({ ...base, action: "clarify", message: "Cette collection n’existe pas dans l’espace actif." }, 400);
        }
        const updated = primaryStep.operation === "add_items"
          ? repository.addCollectionItems(collectionId, scopedIds.map((itemId) => ({ itemId })))
          : primaryStep.operation === "remove_items"
            ? repository.removeCollectionItems(collectionId, scopedIds)
            : repository.updateCollection(collectionId, primaryStep.name ? { name: primaryStep.name } : {})!;
        return context.json({ ...base, action: "collection", collection: collectionView(updated) });
      }
      if (primaryStep.type === "enrich") {
        const seen = new Set<string>();
        const targets = anchorIds.flatMap((id) => {
          const product = repository.getProduct(id, body.workspaceId);
          if (!product || product.kind !== "shop" || seen.has(product.url)) return [];
          seen.add(product.url);
          return [{ productId: product.id, url: product.url }];
        }).slice(0, primaryStep.targetCount);
        if (!targets.length) return context.json({ ...base, action: "clarify", message: "Sélectionne des fiches produit à enrichir." }, 400);
        const job = acquisition.start({ targets, workspaceId: body.workspaceId, source: `assistant:${plan.primaryStepId}` });
        return context.json({ ...base, action: "enrich", job: acquisitionClientView(job) }, 202);
      }
      if (primaryStep.type === "compare_summarize") {
        const products = anchorIds
          .map((id) => repository.getProduct(id, body.workspaceId))
          .filter((product): product is NonNullable<typeof product> => Boolean(product));
        if (!products.length) return context.json({ ...base, action: "clarify", message: "Sélectionne les éléments à comparer." }, 400);
        const prices = products.flatMap((product) => product!.price === null ? [] : [product!.price]);
        const by = (key: "category" | "source") => Object.fromEntries([...new Set(products.map((product) => product![key]))]
          .map((value) => [value, products.filter((product) => product![key] === value).length]));
        return context.json({
          ...base,
          action: primaryStep.mode,
          products: await attachImageAspectRatios(products),
          summary: {
            count: products.length,
            categories: by("category"),
            sources: by("source"),
            price: prices.length ? { min: Math.min(...prices), max: Math.max(...prices), currency: products[0]!.currency } : null,
            question: primaryStep.question,
          },
        });
      }

      if (plan.action === "import_links") {
        return context.json({ ...base, action: plan.action, products: await attachImageAspectRatios(imported.products) }, imported.products.length ? 201 : 422);
      }
      if (plan.action === "similar") {
        if (!anchorIds.length) return context.json({ ...base, action: "clarify", message: "Ajoute au moins un article de référence." }, 400);
        const products = await findSimilarProducts({ productIds: anchorIds, limit: plan.targetCount, constraints }, repository);
        return context.json({ ...base, action: plan.action, products: await attachImageAspectRatios(projectCompactCached(products)) });
      }
      if (plan.action === "visual") {
        const job = await startVisualSelection({
          prompt: plan.query || body.prompt || "Trouve des articles visuellement proches des références jointes.",
          maxCandidates: Math.min(50, Math.max(24, plan.targetCount * 2)),
          topN: Math.min(20, plan.targetCount),
          threshold: .55,
          analysisMode: body.analysisMode,
          reasoningEffort: body.reasoningEffort,
          constraints,
          images: body.images,
        }, repository);
        return context.json({ ...base, action: plan.action, job }, 202);
      }
      if (plan.action === "discover") {
        if (primaryStep.type !== "discover_adapter") {
          return context.json({ ...base, action: "clarify", message: "Le plan de découverte n’a pas de première étape exécutable." }, 400);
        }
        const launched = await launchAssistantDiscoveries([primaryStep]);
        if ("error" in launched) {
          return context.json({ ...base, action: "clarify", message: launched.error }, 400);
        }
        return context.json({ ...base, action: plan.action, ...launched }, 202);
      }
      if (plan.action === "outfit") {
        const anchor = anchorIds[0] ? repository.getProduct(anchorIds[0], body.workspaceId) : null;
        if (!anchor) return context.json({ ...base, action: "clarify", message: "Ajoute une pièce autour de laquelle composer la tenue." }, 400);
        if (workspace.profile !== "clothing") {
          return context.json({ ...base, action: "clarify", message: "La composition automatique de cet espace n’a pas encore de profil métier." }, 400);
        }
        const generated = generateOutfits(anchor, repository.listProducts({ workspaceId: body.workspaceId, limit: 10_000 }), Math.min(3, plan.targetCount));
        const boards = generated.map((outfit) => repository.saveOutfitBoard({
          id: crypto.randomUUID(),
          workspaceId: body.workspaceId,
          name: outfit.title,
          description: `Compatibilité ${outfit.compatibilityScore}/100 · nouveauté ${outfit.noveltyScore}/100`,
          metadata: { anchorProductId: outfit.anchorProductId, compatibilityScore: outfit.compatibilityScore, noveltyScore: outfit.noveltyScore, missingRoles: outfit.missingRoles },
          items: outfit.items.map((item, position) => ({ productId: item.productId, role: item.role, position, notes: item.reason })),
        }));
        return context.json({ ...base, action: plan.action, boards: boards.map(outfitView) }, 201);
      }
      if (plan.action === "clarify") return context.json({
        ...base,
        action: plan.action,
        message: primaryStep.type === "clarify" ? primaryStep.question : plan.message,
      });

      const filterResult = await createFilterWithCodex(plan.query || body.prompt, repository, {
        workspaceId: body.workspaceId,
        profile: workspace.profile,
      });
      if (hardWhere) {
        filterResult.filter.where = {
          type: "group",
          conjunction: "and",
          children: [filterResult.filter.where, hardWhere],
        };
        repository.saveFilter(filterResult.filter, body.workspaceId);
      }
      const products = repository.listProducts({ workspaceId: body.workspaceId, filter: filterResult.filter, limit: filterResult.filter.limit });
      return context.json({
        ...base,
        action: "filter",
        filter: filterResult.filter,
        products: await attachImageAspectRatios(projectCompactCached(products)),
      });
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex assistant failed" }, 500);
    }
  });
  app.post("/api/codex/filter", async (context) => {
    const parsed = z.object({
      prompt: z.string().trim().min(1).max(8_000),
      workspaceId: z.string().trim().min(1).max(128).default(DEFAULT_CLOTHING_WORKSPACE_ID),
    }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid filter request", issues: parsed.error.issues }, 400);
    const workspace = repository.getWorkspace(parsed.data.workspaceId);
    if (!workspace) return context.json({ error: "workspace not found" }, 404);
    try {
      return context.json(await createFilterWithCodex(parsed.data.prompt, repository, {
        workspaceId: workspace.id,
        profile: workspace.profile,
      }), 201);
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex bridge failed" }, 500);
    }
  });
  app.post("/api/codex/discovery-plan", async (context) => {
    const body = await context.req.json<{ prompt?: string; sizes?: string[] }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    try {
      return context.json(await createDiscoveryPlanWithCodex(body.prompt, { sizes: body.sizes }), 201);
    } catch (error) {
      console.error(error);
      return context.json({ error: error instanceof Error ? error.message : "Codex discovery planning failed" }, 500);
    }
  });
  app.post("/api/codex/discover", async (context) => {
    const body = await context.req.json<{ workspaceId?: string; prompt?: string; constraints?: { sizes?: string[] } }>();
    if (!body.prompt?.trim()) return context.json({ error: "prompt is required" }, 400);
    const workspaceId = body.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!repository.getWorkspace(workspaceId)) return context.json({ error: "workspace not found" }, 404);
    try {
      const plan = await createDiscoveryPlanWithCodex(body.prompt, { sizes: body.constraints?.sizes });
      const intents: DiscoveryIntent[] = plan.searches.map((search) => ({
        source: search.source,
        workspaceId,
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
    const job = getVisualSelection(
      context.req.param("id"),
      repository,
      context.req.query("workspaceId") ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    );
    return job ? context.json(job) : context.json({ error: "visual job not found" }, 404);
  });

  return app;
}
