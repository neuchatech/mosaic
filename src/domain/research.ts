import { z } from "zod";
import { filterClauseSchema, filterSpecSchema, type FilterSpec } from "./catalog";
import {
  fieldDefinitionSchema,
  fieldFacetSchema,
  jsonObjectSchema,
  jsonValueSchema,
  workspaceSchema,
} from "./workspace";

export const researchConstraintOperatorSchema = z.enum([
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "gte",
  "lte",
  "between",
  "exists",
  "missing",
]);

export const researchConstraintSchema = z.object({
  field: z.string().trim().min(1).max(160),
  operator: researchConstraintOperatorSchema,
  value: jsonValueSchema.optional(),
  strength: z.enum(["hard", "soft"]).default("hard"),
  weight: z.number().min(0).max(1).default(1),
  reason: z.string().trim().max(500).default(""),
}).superRefine((constraint, context) => {
  const valueless = constraint.operator === "exists" || constraint.operator === "missing";
  if (!valueless && constraint.value === undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: `${constraint.operator} requires a value.` });
  }
  if (valueless && constraint.value !== undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: `${constraint.operator} does not accept a value.` });
  }
  if (constraint.operator === "between" && (!Array.isArray(constraint.value) || constraint.value.length !== 2)) {
    context.addIssue({ code: "custom", path: ["value"], message: "between requires exactly two values." });
  }
});

export const researchBudgetSchema = z.object({
  maxDurationMs: z.number().int().min(10_000).max(15 * 60_000).default(180_000),
  maxToolCalls: z.number().int().min(1).max(160).default(48),
  maxItemsRead: z.number().int().min(1).max(5_000).default(600),
  maxImageInspections: z.number().int().min(0).max(160).default(30),
  maxAcquisitionJobs: z.number().int().min(0).max(12).default(4),
  maxAcquiredItems: z.number().int().min(0).max(1_000).default(160),
  maxCollectionWrites: z.number().int().min(0).max(24).default(4),
});

export const DEFAULT_RESEARCH_BUDGET = {
  maxDurationMs: 180_000,
  maxToolCalls: 48,
  maxItemsRead: 600,
  maxImageInspections: 30,
  maxAcquisitionJobs: 4,
  maxAcquiredItems: 160,
  maxCollectionWrites: 4,
} as const;

export const researchImageInputSchema = z.object({
  name: z.string().trim().max(180).default("reference"),
  mediaPath: z.string().trim().min(1).max(4_096),
  mimeType: z.string().trim().min(1).max(120).default("image/webp"),
});

const researchInputUrlSchema = z.string().url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Research URLs must be credential-free HTTPS URLs.");

export const researchRequestObjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  conversationId: z.string().trim().min(1).max(256).nullable().default(null),
  prompt: z.string().trim().max(80_000).default(""),
  itemIds: z.array(z.string().trim().min(1).max(256)).max(160).default([]),
  collectionIds: z.array(z.string().trim().min(1).max(256)).max(24).default([]),
  images: z.array(researchImageInputSchema).max(12).default([]),
  urls: z.array(researchInputUrlSchema).max(24).default([]),
  constraints: z.array(researchConstraintSchema).max(80).default([]),
  budget: researchBudgetSchema.default(DEFAULT_RESEARCH_BUDGET),
  reasoningEffort: z.enum(["low", "medium"]).default("medium"),
  locale: z.string().trim().min(2).max(35).default("en"),
});

export const researchRequestSchema = researchRequestObjectSchema.superRefine((request, context) => {
  if (!request.prompt && !request.itemIds.length && !request.collectionIds.length && !request.images.length && !request.urls.length) {
    context.addIssue({ code: "custom", path: ["prompt"], message: "A prompt or at least one input is required." });
  }
});

export function researchHardConstraintFilter(
  runId: string,
  constraints: Array<z.infer<typeof researchConstraintSchema>>,
): FilterSpec | undefined {
  const clauses = constraints
    .filter((constraint) => constraint.strength === "hard")
    .map((constraint) => {
      const parsed = filterClauseSchema.safeParse({
        type: "clause",
        field: constraint.field,
        operator: constraint.operator,
        value: constraint.value,
      });
      if (!parsed.success) {
        throw new Error(`Hard constraint ${constraint.field} cannot be enforced: ${parsed.error.message}`);
      }
      return parsed.data;
    });
  if (clauses.length === 0) return undefined;
  return filterSpecSchema.parse({
    id: `research-hard:${runId}`,
    name: "Research hard constraints",
    description: "Automatically enforced by workspace-scoped research tools.",
    where: { type: "group", conjunction: "and", children: clauses },
    limit: 5_000,
  });
}

export function mergeResearchHardConstraints(
  requested: FilterSpec | undefined,
  hard: FilterSpec | undefined,
): FilterSpec | undefined {
  if (!hard) return requested;
  if (!requested) return hard;
  return filterSpecSchema.parse({
    ...requested,
    id: `${requested.id}:research-hard`,
    where: {
      type: "group",
      conjunction: "and",
      children: [hard.where, requested.where],
    },
    limit: Math.min(requested.limit, hard.limit),
  });
}

export const researchSourceCapabilitySchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(160),
  availability: z.enum(["available", "conditional", "unavailable"]).default("available"),
  availabilityReason: z.string().max(1_000).default(""),
  hosts: z.array(z.string().trim().min(1).max(255)).max(40).default([]),
  operations: z.array(z.enum([
    "api",
    "connector",
    "discover",
    "import-url",
    "enrich",
    "structured-data",
    "persistent-browser",
    "interactive-browser",
    "browser-observation-import",
  ])).max(12),
  notes: z.string().max(1_000).default(""),
});

export const researchManifestItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  name: z.string().min(1),
  category: z.string().default(""),
  price: z.number().nullable().default(null),
  currency: z.string().default(""),
  decision: z.string().default("unseen"),
  imageCount: z.number().int().nonnegative(),
  attributes: jsonObjectSchema.default({}),
});

export const researchWorkspaceManifestSchema = z.object({
  version: z.literal(1),
  workspace: workspaceSchema,
  fields: z.array(fieldDefinitionSchema).max(200),
  facets: z.array(fieldFacetSchema).max(200),
  counts: z.object({
    items: z.number().int().nonnegative(),
    withImages: z.number().int().nonnegative(),
    withCoordinates: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    bySource: z.record(z.string(), z.number().int().nonnegative()),
    byDecision: z.record(z.string(), z.number().int().nonnegative()),
  }),
  selectedItems: z.array(researchManifestItemSchema).max(160),
  selectedCollections: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    itemIds: z.array(z.string().min(1)).max(500),
  })).max(24),
  sources: z.array(researchSourceCapabilitySchema).max(100),
  constraints: z.array(researchConstraintSchema).max(80),
  budget: researchBudgetSchema,
  visualIndex: z.object({
    imagesAvailable: z.number().int().nonnegative(),
    coordinatesAvailable: z.number().int().nonnegative(),
    localEmbeddingArtifactAvailable: z.boolean().default(false),
    hybridEmbeddingsMayBeAvailable: z.boolean(),
  }),
  conversation: z.object({
    id: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(160),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(4_000),
      itemIds: z.array(z.string().min(1).max(256)).max(100).default([]),
      collectionIds: z.array(z.string().min(1).max(256)).max(24).default([]),
      artifactIds: z.array(z.string().min(1).max(256)).max(24).default([]),
    })).max(24),
  }).nullable().default(null),
});

export const researchEvidenceSchema = z.object({
  kind: z.enum(["item", "collection", "source", "image", "fact", "warning"]),
  id: z.string().max(500).default(""),
  note: z.string().trim().min(1).max(1_000),
  url: z.string().url().max(2_000).nullable().default(null),
});

export const researchAgentResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(["completed", "partial", "needs_input", "blocked"]),
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(4_000),
  itemIds: z.array(z.string().trim().min(1).max(256)).max(500),
  collectionIds: z.array(z.string().trim().min(1).max(256)).max(50),
  artifactIds: z.array(z.string().trim().min(1).max(256)).max(50),
  filters: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    filter: filterSpecSchema,
  })).max(20),
  evidence: z.array(researchEvidenceSchema).max(100),
  warnings: z.array(z.string().trim().min(1).max(1_000)).max(40),
  followUps: z.array(z.string().trim().min(1).max(500)).max(12),
  metrics: z.object({
    toolCalls: z.number().int().nonnegative(),
    itemsRead: z.number().int().nonnegative(),
    imagesInspected: z.number().int().nonnegative(),
    acquiredItems: z.number().int().nonnegative(),
  }),
});

export const assistantConversationSchema = z.object({
  id: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const assistantMessageStatusSchema = z.enum([
  "sent",
  "running",
  "completed",
  "partial",
  "needs_input",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
]);

export const assistantMessageSchema = z.object({
  id: z.string().trim().min(1).max(256),
  conversationId: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  role: z.enum(["user", "assistant"]),
  status: assistantMessageStatusSchema,
  content: z.string().max(20_000),
  researchRunId: z.string().trim().min(1).max(256).nullable().default(null),
  context: jsonObjectSchema.default({}),
  result: researchAgentResultSchema.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const researchRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "needs_input",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
]);

export const researchRunEventTypeSchema = z.enum([
  "status",
  "tool-call",
  "tool-result",
  "progress",
  "message",
  "result",
  "error",
]);

export const researchRunSchema = z.object({
  id: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  status: researchRunStatusSchema,
  model: z.string().trim().min(1).max(160),
  reasoningEffort: z.enum(["low", "medium"]),
  request: researchRequestSchema,
  manifest: researchWorkspaceManifestSchema,
  result: researchAgentResultSchema.nullable(),
  message: z.string().max(4_000).default(""),
  error: z.string().max(20_000).nullable().default(null),
  eventCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});

export const researchRunEventSchema = z.object({
  runId: z.string().trim().min(1).max(256),
  sequence: z.number().int().positive(),
  type: researchRunEventTypeSchema,
  message: z.string().max(2_000).default(""),
  data: jsonObjectSchema.default({}),
  createdAt: z.string().datetime(),
});

export type ResearchConstraint = z.infer<typeof researchConstraintSchema>;
export type ResearchBudget = z.infer<typeof researchBudgetSchema>;
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchRequestInput = z.input<typeof researchRequestSchema>;
export type ResearchSourceCapability = z.infer<typeof researchSourceCapabilitySchema>;
export type ResearchWorkspaceManifest = z.infer<typeof researchWorkspaceManifestSchema>;
export type ResearchAgentResult = z.infer<typeof researchAgentResultSchema>;
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;
export type AssistantMessageStatus = z.infer<typeof assistantMessageStatusSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
export type ResearchRunEventType = z.infer<typeof researchRunEventTypeSchema>;
export type ResearchRunEvent = z.infer<typeof researchRunEventSchema>;
