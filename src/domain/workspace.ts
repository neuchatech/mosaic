import { z } from "zod";
import { filterSpecSchema } from "./catalog";

export const DEFAULT_CLOTHING_WORKSPACE_ID = "default-clothing";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const workspaceProfileSchema = z.enum(["clothing", "televisions", "generic"]);

export const workspaceSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  profile: workspaceProfileSchema,
  schemaVersion: z.number().int().positive().default(1),
  settings: jsonObjectSchema.default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workspaceCreateSchema = workspaceSchema
  .omit({ createdAt: true, updatedAt: true })
  .partial({ id: true, description: true, schemaVersion: true, settings: true });

export const workspaceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
  profile: workspaceProfileSchema.optional(),
  settings: jsonObjectSchema.optional(),
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;

export const fieldPrimitiveTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "enum",
  "multi-enum",
  "date",
]);

export const fieldDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  key: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(160),
  primitiveType: fieldPrimitiveTypeSchema,
  unit: z.string().trim().min(1).max(40).nullable().default(null),
  semanticRole: z.string().trim().min(1).max(100).nullable().default(null),
  facetable: z.boolean().default(false),
  sortable: z.boolean().default(false),
  display: z.boolean().default(true),
  coverage: z.number().min(0).max(1).default(0),
  cardinality: z.number().int().nonnegative().default(0),
  sourceAliases: z.array(z.string().trim().min(1).max(160)).default([]),
  normalizer: z.string().trim().min(1).max(100).nullable().default(null),
  displayOrder: z.number().int().nonnegative().default(0),
  schemaVersion: z.number().int().positive().default(1),
  inferred: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const fieldDefinitionInputSchema = fieldDefinitionSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  unit: true,
  semanticRole: true,
  facetable: true,
  sortable: true,
  display: true,
  coverage: true,
  cardinality: true,
  sourceAliases: true,
  normalizer: true,
  displayOrder: true,
  inferred: true,
});

export type FieldPrimitiveType = z.infer<typeof fieldPrimitiveTypeSchema>;
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export type FieldDefinitionInput = z.infer<typeof fieldDefinitionInputSchema>;

export const facetValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  count: z.number().int().nonnegative(),
});

export const fieldFacetSchema = z.object({
  fieldKey: z.string().min(1),
  observed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  cardinality: z.number().int().nonnegative(),
  values: z.array(facetValueSchema).default([]),
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
});

export type FieldFacet = z.infer<typeof fieldFacetSchema>;

export const collectionTypeSchema = z.enum([
  "manual",
  "smart",
  "ai-result",
  "generated-artifact",
]);

export const collectionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  type: collectionTypeSchema,
  name: z.string().trim().min(1).max(160),
  color: z.string().trim().min(1).max(80).nullable().default(null),
  icon: z.string().trim().min(1).max(120).nullable().default(null),
  description: z.string().max(2_000).default(""),
  smartFilter: filterSpecSchema.nullable().default(null),
  systemKey: z.string().trim().min(1).max(256).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const collectionCreateSchema = collectionSchema
  .omit({ createdAt: true, updatedAt: true, systemKey: true })
  .partial({ id: true, color: true, icon: true, description: true, smartFilter: true });

export const collectionUpdateSchema = z.object({
  type: collectionTypeSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  color: z.string().trim().min(1).max(80).nullable().optional(),
  icon: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().max(2_000).optional(),
  smartFilter: filterSpecSchema.nullable().optional(),
});

export const collectionItemSchema = z.object({
  collectionId: z.string().trim().min(1).max(256),
  itemId: z.string().trim().min(1).max(256),
  position: z.number().int().nonnegative(),
  role: z.string().trim().min(1).max(100).nullable().default(null),
  notes: z.string().max(2_000).default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const collectionItemInputSchema = collectionItemSchema
  .omit({ collectionId: true, createdAt: true, updatedAt: true })
  .partial({ position: true, role: true, notes: true });

export type CollectionType = z.infer<typeof collectionTypeSchema>;
export type Collection = z.infer<typeof collectionSchema>;
export type CollectionCreate = z.infer<typeof collectionCreateSchema>;
export type CollectionUpdate = z.infer<typeof collectionUpdateSchema>;
export type CollectionItem = z.infer<typeof collectionItemSchema>;
export type CollectionItemInput = z.infer<typeof collectionItemInputSchema>;

export const artifactTypeSchema = z.enum(["image", "report", "comparison", "try-on", "other"]);
export const artifactStatusSchema = z.enum([
  "draft",
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

export const artifactSchema = z.object({
  id: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(128),
  type: artifactTypeSchema,
  name: z.string().trim().min(1).max(160),
  status: artifactStatusSchema.default("draft"),
  localFiles: z.array(z.string().trim().min(1).max(4_096)).default([]),
  prompt: z.string().max(20_000).default(""),
  inputItemIds: z.array(z.string().trim().min(1).max(256)).default([]),
  inputCollectionIds: z.array(z.string().trim().min(1).max(256)).default([]),
  generator: z.string().trim().min(1).max(200).nullable().default(null),
  error: z.string().max(10_000).nullable().default(null),
  provenance: jsonObjectSchema.default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});

export const artifactCreateSchema = artifactSchema
  .omit({ createdAt: true, updatedAt: true, finishedAt: true })
  .partial({ id: true, status: true, localFiles: true, prompt: true, inputItemIds: true,
    inputCollectionIds: true, generator: true, error: true, provenance: true });

export const artifactUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  status: artifactStatusSchema.optional(),
  localFiles: z.array(z.string().trim().min(1).max(4_096)).optional(),
  prompt: z.string().max(20_000).optional(),
  inputItemIds: z.array(z.string().trim().min(1).max(256)).optional(),
  inputCollectionIds: z.array(z.string().trim().min(1).max(256)).optional(),
  generator: z.string().trim().min(1).max(200).nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  provenance: jsonObjectSchema.optional(),
  finishedAt: z.string().datetime().nullable().optional(),
});

/**
 * Public artifact edits deliberately exclude media paths. Artifact media is
 * created and owned by the app, while the wider update schema remains
 * available to trusted repository workers that persist generated outputs.
 */
export const artifactPublicUpdateSchema = artifactUpdateSchema
  .omit({ localFiles: true })
  .strict();

export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactCreate = z.infer<typeof artifactCreateSchema>;
export type ArtifactUpdate = z.infer<typeof artifactUpdateSchema>;
export type ArtifactPublicUpdate = z.infer<typeof artifactPublicUpdateSchema>;

export const runKindSchema = z.enum([
  "discovery",
  "import",
  "enrichment",
  "embedding",
  "visual-scoring",
  "generation",
  "research",
  "agent",
]);

export const runStatusSchema = z.enum([
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

/** Normalized Activity representation; specialized job tables remain valid. */
export const runViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: runKindSchema,
  title: z.string().min(1),
  source: z.string().nullable().default(null),
  status: runStatusSchema,
  progress: z.number().min(0).max(1),
  total: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0),
  succeeded: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  cancelled: z.number().int().nonnegative().default(0),
  message: z.string().default(""),
  error: z.string().nullable().default(null),
  canCancel: z.boolean().default(false),
  canResume: z.boolean().default(false),
  plan: jsonObjectSchema.default({}),
  metadata: jsonObjectSchema.default({}),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});

export type RunKind = z.infer<typeof runKindSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunView = z.infer<typeof runViewSchema>;

export const workspaceSchemaViewSchema = z.object({
  workspace: workspaceSchema,
  fields: z.array(fieldDefinitionSchema),
  facets: z.array(fieldFacetSchema),
});

export type WorkspaceSchemaView = z.infer<typeof workspaceSchemaViewSchema>;
