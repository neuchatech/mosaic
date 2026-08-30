import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { applyFilter } from "../src/domain/filter";
import {
  decisionSchema,
  filterSpecSchema,
  productPatchSchema,
  productSchema,
  type FilterSpec,
  type Product,
  type ProductDecision,
  type ProductPatch,
} from "../src/domain/catalog";
import {
  DEFAULT_CLOTHING_WORKSPACE_ID,
  artifactCreateSchema,
  artifactSchema,
  artifactUpdateSchema,
  collectionCreateSchema,
  collectionItemInputSchema,
  collectionSchema,
  collectionUpdateSchema,
  fieldDefinitionInputSchema,
  fieldDefinitionSchema,
  workspaceCreateSchema,
  workspaceSchema,
  workspaceUpdateSchema,
  type Artifact,
  type ArtifactCreate,
  type ArtifactStatus,
  type ArtifactType,
  type ArtifactUpdate,
  type Collection,
  type CollectionCreate,
  type CollectionItem,
  type CollectionItemInput,
  type CollectionUpdate,
  type FieldDefinition,
  type FieldDefinitionInput,
  type FieldFacet,
  type FieldPrimitiveType,
  type Workspace,
  type WorkspaceCreate,
  type WorkspaceSchemaView,
  type WorkspaceUpdate,
} from "../src/domain/workspace";
import { stableProductId, stableWorkspaceProductId } from "../src/domain/ids";
import { getDatabase } from "./database";
import {
  migrateWorkspaceSchema,
  syncFavoritesCompatibility,
  syncOutfitBoardCompatibility,
} from "./workspace-schema";

type ProductRow = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type NormalizedProduct = ReturnType<typeof productSchema.parse>;

export type DecisionActionResult = { actionId: string; products: Product[] };

export type DecisionActionRecord = {
  id: string;
  workspaceId: string;
  createdAt: string;
  undoneAt: string | null;
  items: Array<{
    productId: string;
    before: ProductDecision;
    after: ProductDecision;
  }>;
};

export type SavedViewRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  filter: FilterSpec;
  state: JsonObject;
  createdAt: string;
  updatedAt: string;
};

export type AcquisitionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type AcquisitionJobRecord = {
  id: string;
  workspaceId: string;
  source: string;
  kind: string;
  status: AcquisitionStatus;
  totalItems: number;
  succeededItems: number;
  failedItems: number;
  blockedItems: number;
  cancelledItems: number;
  pendingItems: number;
  progress: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

export type AcquisitionJobItem = {
  id: string;
  jobId: string;
  productId: string | null;
  url: string;
  status: AcquisitionStatus;
  attempts: number;
  payload: JsonObject;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type OutfitBoardItem = {
  productId: string;
  role: string;
  position: number;
  notes: string;
};

export type OutfitBoardRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  metadata: JsonObject;
  items: OutfitBoardItem[];
  createdAt: string;
  updatedAt: string;
};

export type VisualJobStatus = "planning" | "scoring" | "complete" | "error";

export type VisualJobRecord = {
  id: string;
  workspaceId: string;
  prompt: string;
  status: VisualJobStatus;
  message: string;
  maxInspections: number;
  targetCount: number;
  threshold: number;
  analysisMode: "sequential" | "sheet";
  referenceImages: string[];
  constraints: JsonObject;
  candidatesFrozenAt: string | null;
  candidateCount: number;
  inspected: number;
  selected: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type VisualAssessment = {
  jobId: string;
  productId: string;
  score: number;
  rejected: boolean;
  reason: string;
  signals: string[];
  createdAt: string;
};

export type CollectionRecord = Collection & {
  items: CollectionItem[];
};

export type WorkspaceSchemaInferenceOptions = {
  minCoverage?: number;
  minObserved?: number;
  minFacetCardinality?: number;
  maxFacetCardinality?: number;
  maxFacetRatio?: number;
};

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return workspaceSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    profile: row.profile,
    schemaVersion: row.schema_version,
    settings: parseJson(row.settings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToFieldDefinition(row: Record<string, unknown>): FieldDefinition {
  return fieldDefinitionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.field_key,
    label: row.label,
    primitiveType: row.primitive_type,
    unit: row.unit ?? null,
    semanticRole: row.semantic_role ?? null,
    facetable: Boolean(row.facetable),
    sortable: Boolean(row.sortable),
    display: Boolean(row.display_enabled),
    coverage: row.coverage,
    cardinality: row.cardinality,
    sourceAliases: parseJson(row.source_aliases_json, []),
    normalizer: row.normalizer ?? null,
    displayOrder: row.display_order,
    schemaVersion: row.schema_version,
    inferred: Boolean(row.inferred),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToCollectionItem(row: Record<string, unknown>): CollectionItem {
  return {
    collectionId: String(row.collection_id),
    itemId: String(row.product_id),
    position: Number(row.position),
    role: row.role ? String(row.role) : null,
    notes: String(row.notes ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToCollection(row: Record<string, unknown>): Collection {
  return collectionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.collection_type,
    name: row.name,
    color: row.color ?? null,
    icon: row.icon ?? null,
    description: row.description,
    smartFilter: row.smart_filter_json ? parseJson(row.smart_filter_json, null) : null,
    systemKey: row.system_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToArtifact(row: Record<string, unknown>): Artifact {
  return artifactSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.artifact_type,
    name: row.name,
    status: row.status,
    localFiles: parseJson(row.local_files_json, []),
    prompt: row.prompt,
    inputItemIds: parseJson(row.input_item_ids_json, []),
    inputCollectionIds: parseJson(row.input_collection_ids_json, []),
    generator: row.generator ?? null,
    error: row.error ?? null,
    provenance: parseJson(row.provenance_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
  });
}

function valueAtField(product: Product, key: string): unknown {
  return key.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, product);
}

function isObserved(value: unknown): boolean {
  return value !== undefined
    && value !== null
    && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function primitiveValues(value: unknown): Array<string | number | boolean> {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string | number | boolean => (
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
  ));
}

function normalizedFacetKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value).trim().toLocaleLowerCase("fr-CH")}`;
}

function humanizeFieldKey(key: string): string {
  const leaf = key.split(".").at(-1) ?? key;
  const spaced = leaf
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : key;
}

function inferredUnit(key: string): string | null {
  const normalized = key.toLocaleLowerCase();
  if (/(?:^|[_.-])(?:hz|refresh.?rate)$/.test(normalized)) return "Hz";
  if (/(?:inch|inches|screen.?size|diagonal)/.test(normalized)) return "in";
  if (/(?:^|[_.-])kg$|weight.?kg/.test(normalized)) return "kg";
  if (/(?:^|[_.-])cm$/.test(normalized)) return "cm";
  if (/(?:^|[_.-])mm$/.test(normalized)) return "mm";
  if (/(?:watt|power.?w|[_.-]w$)/.test(normalized)) return "W";
  return null;
}

function inferredSemanticRole(key: string): string | null {
  const normalized = key.toLocaleLowerCase();
  if (key === "brand") return "identity.maker";
  if (key === "source") return "identity.source";
  if (key === "category") return "semantics.category";
  if (key === "price") return "commerce.price";
  if (key === "stockStatus") return "commerce.availability";
  if (/(?:screen.?size|diagonal)/.test(normalized)) return "display.diagonal";
  if (/(?:refresh.?rate|hz)/.test(normalized)) return "display.refresh-rate";
  if (/resolution/.test(normalized)) return "display.resolution";
  return null;
}

function inferPrimitiveType(values: unknown[]): FieldPrimitiveType | null {
  if (values.every((value) => Array.isArray(value))) {
    const flattened = values.flatMap(primitiveValues);
    return flattened.length > 0 ? "multi-enum" : null;
  }
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => typeof value === "number" && Number.isFinite(value))) return "number";
  if (values.every((value) => typeof value === "string")) {
    const strings = values as string[];
    if (strings.every((value) => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)))) {
      return "date";
    }
    return "enum";
  }
  return null;
}

function candidateFields(products: Product[], profile: Workspace["profile"]): Array<{
  key: string;
  alias: string;
  values: unknown[];
  observed: number;
}> {
  const fields = new Map<string, { alias: string; values: unknown[]; observed: number }>();
  const universal = ["brand", "category", "price", "currency", "source", "stockStatus", "available", "tags"];
  const clothing = ["colorFamily", "fit", "sizes", "materials"];
  for (const product of products) {
    const entries: Array<[string, string, unknown]> = [
      ...universal.map((key) => [key, key, valueAtField(product, key)] as [string, string, unknown]),
      ...(profile === "clothing"
        ? clothing.map((key) => [key, key, valueAtField(product, key)] as [string, string, unknown])
        : []),
      ...Object.entries(product.attributes ?? {}).map(([key, value]) => [
        `attributes.${key}`,
        key,
        value,
      ] as [string, string, unknown]),
    ];
    for (const [key, alias, value] of entries) {
      if (!isObserved(value) || key.length > 160) continue;
      const current = fields.get(key) ?? { alias, values: [], observed: 0 };
      current.values.push(value);
      current.observed += 1;
      fields.set(key, current);
    }
  }
  return [...fields.entries()].map(([key, value]) => ({ key, ...value }));
}

/** Pure, conservative suggestions. Call commitWorkspaceSchema explicitly to persist. */
export function inferFieldDefinitionsFromProducts(
  workspace: Workspace,
  products: Product[],
  options: WorkspaceSchemaInferenceOptions = {},
): FieldDefinition[] {
  const total = products.length;
  if (total === 0) return [];
  const minCoverage = Math.min(1, Math.max(0, options.minCoverage ?? 0.6));
  const minObserved = Math.max(1, options.minObserved ?? 3);
  const minFacetCardinality = Math.max(2, options.minFacetCardinality ?? 2);
  const maxFacetCardinality = Math.max(minFacetCardinality, options.maxFacetCardinality ?? 40);
  const maxFacetRatio = Math.min(1, Math.max(0, options.maxFacetRatio ?? 0.5));
  const now = new Date().toISOString();
  const preferredOrder = new Map([
    "category", "brand", "price", "source", "stockStatus", "colorFamily", "fit", "sizes", "materials", "tags",
  ].map((key, index) => [key, index]));

  return candidateFields(products, workspace.profile).flatMap((candidate) => {
    const coverage = candidate.observed / total;
    if (candidate.observed < minObserved || coverage < minCoverage) return [];
    const primitiveType = inferPrimitiveType(candidate.values);
    if (!primitiveType) return [];
    const values = candidate.values.flatMap(primitiveValues);
    const cardinality = new Set(values.map(normalizedFacetKey)).size;
    const enumLike = primitiveType === "enum" || primitiveType === "multi-enum" || primitiveType === "boolean";
    const facetRatio = cardinality / Math.max(candidate.observed, 1);
    const facetable = primitiveType === "number"
      ? cardinality >= minFacetCardinality
      : enumLike
        && cardinality >= minFacetCardinality
        && cardinality <= maxFacetCardinality
        && facetRatio <= maxFacetRatio;
    const normalizedType: FieldPrimitiveType = primitiveType === "enum" && !facetable
      ? "text"
      : primitiveType;
    const order = preferredOrder.get(candidate.key)
      ?? (100 + [...candidateFields(products, workspace.profile)]
        .map(({ key }) => key)
        .sort()
        .indexOf(candidate.key));
    return [fieldDefinitionSchema.parse({
      id: `field:${workspace.id}:${candidate.key}`,
      workspaceId: workspace.id,
      key: candidate.key,
      label: humanizeFieldKey(candidate.key),
      primitiveType: normalizedType,
      unit: inferredUnit(candidate.key),
      semanticRole: inferredSemanticRole(candidate.key),
      facetable,
      sortable: normalizedType === "number" || normalizedType === "date" || normalizedType === "text" || normalizedType === "enum",
      display: true,
      coverage,
      cardinality,
      sourceAliases: [candidate.alias],
      normalizer: normalizedType === "number"
        ? "number"
        : normalizedType === "boolean"
          ? "boolean"
          : normalizedType === "date"
            ? "iso-date"
            : normalizedType === "multi-enum"
              ? "string-list"
              : "trim",
      displayOrder: order,
      schemaVersion: workspace.schemaVersion + 1,
      inferred: true,
      createdAt: now,
      updatedAt: now,
    })];
  }).sort((left, right) => left.displayOrder - right.displayOrder || left.key.localeCompare(right.key));
}

export function facetFromProducts(
  products: Product[],
  fieldKey: string,
  maxValues = 50,
): FieldFacet {
  const counts = new Map<string, { value: string | number | boolean; count: number }>();
  let observed = 0;
  const numeric: number[] = [];
  for (const product of products) {
    const value = valueAtField(product, fieldKey);
    if (!isObserved(value)) continue;
    observed += 1;
    const perItem = new Map(primitiveValues(value).map((entry) => [normalizedFacetKey(entry), entry]));
    for (const [key, entry] of perItem) {
      const current = counts.get(key);
      counts.set(key, { value: entry, count: (current?.count ?? 0) + 1 });
      if (typeof entry === "number" && Number.isFinite(entry)) numeric.push(entry);
    }
  }
  return {
    fieldKey,
    observed,
    total: products.length,
    coverage: products.length === 0 ? 0 : observed / products.length,
    cardinality: counts.size,
    values: [...counts.values()]
      .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)))
      .slice(0, Math.min(Math.max(maxValues, 0), 200)),
    min: numeric.length > 0 ? Math.min(...numeric) : null,
    max: numeric.length > 0 ? Math.max(...numeric) : null,
  };
}

function rowToProduct(row: ProductRow): Product {
  return productSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    kind: row.kind,
    source: row.source,
    sourceId: row.source_id,
    url: row.url,
    brand: row.brand,
    name: row.name,
    description: row.description,
    price: row.price,
    originalPrice: row.original_price,
    currency: row.currency,
    category: row.category,
    color: row.color,
    colorFamily: row.color_family,
    fit: row.fit,
    attributes: parseJson(row.attributes_json, {}),
    materials: parseJson(row.materials_json, []),
    tags: parseJson(row.tags_json, []),
    annotations: parseJson(row.annotations_json, {}),
    sizes: parseJson(row.sizes_json, []),
    images: parseJson(row.images_json, []),
    available: Boolean(row.available),
    stockStatus: row.stock_status ?? "unknown",
    stockCheckedAt: row.stock_checked_at ?? null,
    priceCheckedAt: row.price_checked_at ?? null,
    sizesCheckedAt: row.sizes_checked_at ?? null,
    decision: row.decision,
    x: row.x,
    y: row.y,
    embeddingRevision: row.embedding_revision ?? null,
    scores: parseJson(row.scores_json, {}),
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  });
}

function productParameters(product: NormalizedProduct): Record<string, unknown> {
  return {
    ...product,
    originalPrice: product.originalPrice,
    attributes: JSON.stringify(product.attributes),
    materials: JSON.stringify(product.materials),
    tags: JSON.stringify(product.tags),
    annotations: JSON.stringify(product.annotations),
    sizes: JSON.stringify(product.sizes),
    images: JSON.stringify(product.images),
    scores: JSON.stringify(product.scores),
    available: product.available ? 1 : 0,
  };
}

function acquisitionItemFromRow(row: Record<string, unknown>): AcquisitionJobItem {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    productId: row.product_id ? String(row.product_id) : null,
    url: String(row.url),
    status: row.status as AcquisitionStatus,
    attempts: Number(row.attempts),
    payload: parseJson(row.payload_json, {}),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

export class CatalogRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {
    migrateWorkspaceSchema(this.db);
  }

  createWorkspace(input: WorkspaceCreate): Workspace {
    const parsed = workspaceCreateSchema.parse(input);
    const id = parsed.id ?? `workspace-${randomUUID()}`;
    if (this.getWorkspace(id)) throw new Error(`Workspace already exists: ${id}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspaces (
        id, name, description, profile, schema_version, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      parsed.name,
      parsed.description,
      parsed.profile,
      parsed.schemaVersion,
      JSON.stringify(parsed.settings),
      now,
      now,
    );
    syncFavoritesCompatibility(this.db, id);
    return this.getWorkspace(id)!;
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspaces ORDER BY updated_at DESC, name, id
    `).all() as Record<string, unknown>[];
    return rows.map(rowToWorkspace);
  }

  updateWorkspace(id: string, patch: WorkspaceUpdate): Workspace | null {
    const current = this.getWorkspace(id);
    if (!current) return null;
    const parsed = workspaceUpdateSchema.parse(patch);
    const next = workspaceSchema.parse({
      ...current,
      ...parsed,
      settings: parsed.settings ? { ...current.settings, ...parsed.settings } : current.settings,
      updatedAt: new Date().toISOString(),
    });
    this.db.prepare(`
      UPDATE workspaces SET name = ?, description = ?, profile = ?, settings_json = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.description, next.profile, JSON.stringify(next.settings), next.updatedAt, id);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): boolean {
    if (id === DEFAULT_CLOTHING_WORKSPACE_ID) return false;
    const count = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM products WHERE workspace_id = ?
    `).get(id) as { count?: number } | undefined)?.count ?? 0);
    if (count > 0) throw new Error(`Workspace ${id} still contains ${count} item(s).`);
    return this.db.transaction(() => {
      // These two legacy-compatible tables cannot gain a foreign key through
      // SQLite's additive ALTER TABLE path, so clean them explicitly.
      this.db.prepare("DELETE FROM saved_filters WHERE workspace_id = ?").run(id);
      this.db.prepare("DELETE FROM saved_views WHERE workspace_id = ?").run(id);
      return this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
    })();
  }

  saveFieldDefinition(input: FieldDefinitionInput): FieldDefinition {
    return this.saveFieldDefinitions([input])[0]!;
  }

  saveFieldDefinitions(inputs: FieldDefinitionInput[]): FieldDefinition[] {
    if (inputs.length === 0) return [];
    const parsed = inputs.map((input) => fieldDefinitionInputSchema.parse(input));
    const workspaceIds = unique(parsed.map((input) => input.workspaceId));
    if (workspaceIds.length !== 1) throw new Error("Field definitions must target one workspace per write.");
    const workspace = this.getWorkspace(workspaceIds[0]!);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceIds[0]}`);
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO workspace_field_definitions (
        id, workspace_id, field_key, label, primitive_type, unit, semantic_role,
        facetable, sortable, display_enabled, coverage, cardinality,
        source_aliases_json, normalizer, display_order, schema_version,
        inferred, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, field_key) DO UPDATE SET
        label=excluded.label, primitive_type=excluded.primitive_type, unit=excluded.unit,
        semantic_role=excluded.semantic_role, facetable=excluded.facetable,
        sortable=excluded.sortable, display_enabled=excluded.display_enabled,
        coverage=excluded.coverage, cardinality=excluded.cardinality,
        source_aliases_json=excluded.source_aliases_json, normalizer=excluded.normalizer,
        display_order=excluded.display_order, schema_version=excluded.schema_version,
        inferred=excluded.inferred, updated_at=excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const input of parsed) {
        const existing = this.getFieldDefinition(input.workspaceId, input.key);
        statement.run(
          existing?.id ?? `field:${input.workspaceId}:${input.key}`,
          input.workspaceId,
          input.key,
          input.label,
          input.primitiveType,
          input.unit,
          input.semanticRole,
          input.facetable ? 1 : 0,
          input.sortable ? 1 : 0,
          input.display ? 1 : 0,
          input.coverage,
          input.cardinality,
          JSON.stringify(input.sourceAliases),
          input.normalizer,
          input.displayOrder,
          workspace.schemaVersion,
          input.inferred ? 1 : 0,
          existing?.createdAt ?? now,
          now,
        );
      }
    })();
    return parsed.map((input) => this.getFieldDefinition(input.workspaceId, input.key)!);
  }

  getFieldDefinition(workspaceId: string, key: string): FieldDefinition | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_field_definitions WHERE workspace_id = ? AND field_key = ?
    `).get(workspaceId, key) as Record<string, unknown> | undefined;
    return row ? rowToFieldDefinition(row) : null;
  }

  listFieldDefinitions(
    workspaceId: string,
    options: { facetable?: boolean; display?: boolean } = {},
  ): FieldDefinition[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_field_definitions WHERE workspace_id = ?
      ORDER BY display_order, field_key
    `).all(workspaceId) as Record<string, unknown>[];
    return rows.map(rowToFieldDefinition).filter((field) => (
      (options.facetable === undefined || field.facetable === options.facetable)
      && (options.display === undefined || field.display === options.display)
    ));
  }

  deleteFieldDefinition(workspaceId: string, key: string): boolean {
    return this.db.prepare(`
      DELETE FROM workspace_field_definitions WHERE workspace_id = ? AND field_key = ?
    `).run(workspaceId, key).changes > 0;
  }

  inferWorkspaceSchema(
    workspaceId: string,
    options: WorkspaceSchemaInferenceOptions = {},
  ): FieldDefinition[] {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    return inferFieldDefinitionsFromProducts(
      workspace,
      this.listProducts({ workspaceId, limit: 10_000 }),
      options,
    );
  }

  commitWorkspaceSchema(
    workspaceId: string,
    definitions: FieldDefinitionInput[],
    options: { replace?: boolean } = {},
  ): FieldDefinition[] {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const parsed = definitions.map((definition) => fieldDefinitionInputSchema.parse({
      ...definition,
      workspaceId,
    }));
    const nextVersion = workspace.schemaVersion + 1;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE workspaces SET schema_version = ?, updated_at = ? WHERE id = ?
      `).run(nextVersion, new Date().toISOString(), workspaceId);
      if (options.replace) {
        this.db.prepare("DELETE FROM workspace_field_definitions WHERE workspace_id = ?").run(workspaceId);
      }
      this.saveFieldDefinitions(parsed);
      this.db.prepare(`
        UPDATE workspace_field_definitions SET schema_version = ? WHERE workspace_id = ?
      `).run(nextVersion, workspaceId);
    })();
    return this.listFieldDefinitions(workspaceId);
  }

  getWorkspaceFacets(workspaceId: string, fieldKeys?: string[]): FieldFacet[] {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const products = this.listProducts({ workspaceId, limit: 10_000 });
    const keys = fieldKeys ?? this.listFieldDefinitions(workspaceId, { facetable: true }).map(({ key }) => key);
    return unique(keys).map((key) => facetFromProducts(products, key));
  }

  getWorkspaceSchema(workspaceId: string): WorkspaceSchemaView {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const fields = this.listFieldDefinitions(workspaceId);
    return {
      workspace,
      fields,
      facets: this.getWorkspaceFacets(
        workspaceId,
        fields.filter(({ facetable }) => facetable).map(({ key }) => key),
      ),
    };
  }

  createCollection(input: CollectionCreate): CollectionRecord {
    const parsed = collectionCreateSchema.parse(input);
    if (!this.getWorkspace(parsed.workspaceId)) throw new Error(`Unknown workspace: ${parsed.workspaceId}`);
    if (parsed.type === "smart" && !parsed.smartFilter) {
      throw new Error("Smart collections require a smartFilter.");
    }
    const id = parsed.id ?? `collection-${randomUUID()}`;
    if (this.getCollection(id)) throw new Error(`Collection already exists: ${id}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO collections (
        id, workspace_id, collection_type, name, color, icon, description,
        smart_filter_json, system_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      parsed.workspaceId,
      parsed.type,
      parsed.name,
      parsed.color,
      parsed.icon,
      parsed.description,
      parsed.smartFilter ? JSON.stringify(parsed.smartFilter) : null,
      now,
      now,
    );
    return this.getCollection(id, parsed.workspaceId)!;
  }

  getCollection(id: string, workspaceId?: string): CollectionRecord | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM collections WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM collections WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = this.db.prepare(`
      SELECT * FROM collection_items WHERE collection_id = ?
      ORDER BY position, created_at, product_id
    `).all(id) as Record<string, unknown>[];
    return { ...rowToCollection(row), items: items.map(rowToCollectionItem) };
  }

  listCollections(workspaceId: string): CollectionRecord[] {
    const rows = this.db.prepare(`
      SELECT id FROM collections WHERE workspace_id = ? ORDER BY updated_at DESC, name, id
    `).all(workspaceId) as { id: string }[];
    return rows.map(({ id }) => this.getCollection(id, workspaceId)).filter(Boolean) as CollectionRecord[];
  }

  updateCollection(id: string, patch: CollectionUpdate, workspaceId?: string): CollectionRecord | null {
    const current = this.getCollection(id, workspaceId);
    if (!current) return null;
    const parsed = collectionUpdateSchema.parse(patch);
    const next = collectionSchema.parse({
      ...current,
      ...parsed,
      updatedAt: new Date().toISOString(),
    });
    if (next.type === "smart" && !next.smartFilter) {
      throw new Error("Smart collections require a smartFilter.");
    }
    this.db.prepare(`
      UPDATE collections SET collection_type = ?, name = ?, color = ?, icon = ?,
        description = ?, smart_filter_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?
    `).run(
      next.type,
      next.name,
      next.color,
      next.icon,
      next.description,
      next.smartFilter ? JSON.stringify(next.smartFilter) : null,
      next.updatedAt,
      id,
      current.workspaceId,
    );
    return this.getCollection(id, current.workspaceId);
  }

  deleteCollection(id: string, workspaceId?: string): boolean {
    const collection = this.getCollection(id, workspaceId);
    if (!collection || collection.systemKey === "favorites") return false;
    return this.db.prepare("DELETE FROM collections WHERE id = ? AND workspace_id = ?")
      .run(id, collection.workspaceId).changes > 0;
  }

  replaceCollectionItems(id: string, inputs: CollectionItemInput[], workspaceId?: string): CollectionRecord {
    const collection = this.getCollection(id, workspaceId);
    if (!collection) throw new Error(`Unknown collection: ${id}`);
    if (collection.systemKey === "favorites") {
      throw new Error("Favorites membership is synchronized through item decisions.");
    }
    const parsed = inputs.map((input) => collectionItemInputSchema.parse(input));
    const ids = parsed.map(({ itemId }) => itemId);
    if (unique(ids).length !== ids.length) throw new Error("Collection items must be unique.");
    const missingOrForeign = ids.filter((itemId) => !this.getProduct(itemId, collection.workspaceId));
    if (missingOrForeign.length > 0) {
      throw new Error(`Unknown or cross-workspace collection items: ${missingOrForeign.join(", ")}`);
    }
    const ordered = parsed
      .map((item, ordinal) => ({ item, ordinal, requested: item.position ?? ordinal }))
      .sort((left, right) => left.requested - right.requested || left.ordinal - right.ordinal);
    const created = new Map(collection.items.map((item) => [item.itemId, item.createdAt]));
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(id);
      const insert = this.db.prepare(`
        INSERT INTO collection_items (
          collection_id, product_id, position, role, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      ordered.forEach(({ item }, position) => insert.run(
        id,
        item.itemId,
        position,
        item.role,
        item.notes,
        created.get(item.itemId) ?? now,
        now,
      ));
      this.db.prepare("UPDATE collections SET updated_at = ? WHERE id = ?").run(now, id);
    })();
    return this.getCollection(id, collection.workspaceId)!;
  }

  addCollectionItems(id: string, inputs: CollectionItemInput[], workspaceId?: string): CollectionRecord {
    const collection = this.getCollection(id, workspaceId);
    if (!collection) throw new Error(`Unknown collection: ${id}`);
    const combined = new Map<string, CollectionItemInput>(collection.items.map((item) => [item.itemId, {
      itemId: item.itemId,
      position: item.position,
      role: item.role,
      notes: item.notes,
    }]));
    for (const input of inputs.map((item) => collectionItemInputSchema.parse(item))) {
      const existing = combined.get(input.itemId);
      combined.set(input.itemId, {
        ...existing,
        ...input,
        position: input.position ?? existing?.position ?? combined.size,
      });
    }
    return this.replaceCollectionItems(id, [...combined.values()], collection.workspaceId);
  }

  removeCollectionItems(id: string, itemIds: string[], workspaceId?: string): CollectionRecord {
    const collection = this.getCollection(id, workspaceId);
    if (!collection) throw new Error(`Unknown collection: ${id}`);
    const removed = new Set(itemIds);
    return this.replaceCollectionItems(id, collection.items
      .filter((item) => !removed.has(item.itemId))
      .map((item) => ({
        itemId: item.itemId,
        position: item.position,
        role: item.role,
        notes: item.notes,
      })), collection.workspaceId);
  }

  syncFavoritesCollection(workspaceId: string): CollectionRecord {
    return this.getCollection(syncFavoritesCompatibility(this.db, workspaceId), workspaceId)!;
  }

  createArtifact(input: ArtifactCreate): Artifact {
    const parsed = artifactCreateSchema.parse(input);
    if (!this.getWorkspace(parsed.workspaceId)) throw new Error(`Unknown workspace: ${parsed.workspaceId}`);
    const id = parsed.id ?? `artifact-${randomUUID()}`;
    if (this.getArtifact(id)) throw new Error(`Artifact already exists: ${id}`);
    const now = new Date().toISOString();
    const artifact = artifactSchema.parse({
      ...parsed,
      id,
      createdAt: now,
      updatedAt: now,
      finishedAt: ["succeeded", "failed", "blocked", "cancelled"].includes(parsed.status ?? "draft")
        ? now
        : null,
    });
    this.validateArtifactInputs(
      artifact.workspaceId,
      artifact.inputItemIds,
      artifact.inputCollectionIds,
    );
    this.db.prepare(`
      INSERT INTO artifacts (
        id, workspace_id, artifact_type, name, status, local_files_json, prompt,
        input_item_ids_json, input_collection_ids_json, generator, error,
        provenance_json, created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      artifact.workspaceId,
      artifact.type,
      artifact.name,
      artifact.status,
      JSON.stringify(unique(artifact.localFiles)),
      artifact.prompt,
      JSON.stringify(unique(artifact.inputItemIds)),
      JSON.stringify(unique(artifact.inputCollectionIds)),
      artifact.generator,
      artifact.error,
      JSON.stringify(artifact.provenance),
      artifact.createdAt,
      artifact.updatedAt,
      artifact.finishedAt,
    );
    return this.getArtifact(id, artifact.workspaceId)!;
  }

  getArtifact(id: string, workspaceId?: string): Artifact | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM artifacts WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listArtifacts(workspaceId: string, options: {
    type?: ArtifactType;
    status?: ArtifactStatus;
    limit?: number;
  } = {}): Artifact[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const rows = this.db.prepare(`
      SELECT * FROM artifacts WHERE workspace_id = ?
        AND (? IS NULL OR artifact_type = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY updated_at DESC, id LIMIT ?
    `).all(
      workspaceId,
      options.type ?? null,
      options.type ?? null,
      options.status ?? null,
      options.status ?? null,
      limit,
    ) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  }

  updateArtifact(id: string, patch: ArtifactUpdate, workspaceId?: string): Artifact | null {
    const current = this.getArtifact(id, workspaceId);
    if (!current) return null;
    const parsed = artifactUpdateSchema.parse(patch);
    const supplied = (key: keyof ArtifactUpdate): boolean => (
      Object.prototype.hasOwnProperty.call(patch, key)
    );
    const nextStatus = supplied("status") && parsed.status !== undefined
      ? parsed.status
      : current.status;
    const terminalStatus = ["succeeded", "failed", "blocked", "cancelled"].includes(nextStatus);
    const next = artifactSchema.parse({
      ...current,
      name: supplied("name") && parsed.name !== undefined ? parsed.name : current.name,
      status: nextStatus,
      localFiles: supplied("localFiles") && parsed.localFiles !== undefined
        ? unique(parsed.localFiles)
        : current.localFiles,
      prompt: supplied("prompt") && parsed.prompt !== undefined ? parsed.prompt : current.prompt,
      inputItemIds: supplied("inputItemIds") && parsed.inputItemIds !== undefined
        ? unique(parsed.inputItemIds)
        : current.inputItemIds,
      inputCollectionIds: supplied("inputCollectionIds") && parsed.inputCollectionIds !== undefined
        ? unique(parsed.inputCollectionIds)
        : current.inputCollectionIds,
      generator: supplied("generator") ? (parsed.generator ?? null) : current.generator,
      error: supplied("error") ? (parsed.error ?? null) : current.error,
      provenance: supplied("provenance") && parsed.provenance !== undefined
        ? parsed.provenance
        : current.provenance,
      finishedAt: supplied("finishedAt")
        ? parsed.finishedAt
        : terminalStatus
          ? (current.finishedAt ?? new Date().toISOString())
          : null,
      updatedAt: new Date().toISOString(),
    });
    this.validateArtifactInputs(next.workspaceId, next.inputItemIds, next.inputCollectionIds);
    this.db.prepare(`
      UPDATE artifacts SET name = ?, status = ?, local_files_json = ?, prompt = ?,
        input_item_ids_json = ?, input_collection_ids_json = ?, generator = ?, error = ?,
        provenance_json = ?, updated_at = ?, finished_at = ? WHERE id = ? AND workspace_id = ?
    `).run(
      next.name,
      next.status,
      JSON.stringify(next.localFiles),
      next.prompt,
      JSON.stringify(next.inputItemIds),
      JSON.stringify(next.inputCollectionIds),
      next.generator,
      next.error,
      JSON.stringify(next.provenance),
      next.updatedAt,
      next.finishedAt,
      id,
      current.workspaceId,
    );
    return this.getArtifact(id, current.workspaceId);
  }

  deleteArtifact(id: string, workspaceId?: string): boolean {
    const artifact = this.getArtifact(id, workspaceId);
    if (!artifact) return false;
    return this.db.prepare("DELETE FROM artifacts WHERE id = ? AND workspace_id = ?")
      .run(id, artifact.workspaceId).changes > 0;
  }

  private validateArtifactInputs(
    workspaceId: string,
    itemIds: string[],
    collectionIds: string[],
  ): void {
    const invalidItems = unique(itemIds).filter((id) => !this.getProduct(id, workspaceId));
    const invalidCollections = unique(collectionIds).filter((id) => (
      !this.getCollection(id, workspaceId)
    ));
    if (invalidItems.length > 0 || invalidCollections.length > 0) {
      throw new Error([
        invalidItems.length ? `items: ${invalidItems.join(", ")}` : "",
        invalidCollections.length ? `collections: ${invalidCollections.join(", ")}` : "",
      ].filter(Boolean).join("; "));
    }
  }

  listProducts(options: {
    workspaceId?: string;
    search?: string;
    filter?: FilterSpec;
    limit?: number;
  } = {}): Product[] {
    const limit = Math.min(Math.max(options.limit ?? 5000, 0), 10_000);
    const rows = options.search && options.workspaceId
      ? this.db.prepare(`
          SELECT * FROM products
          WHERE workspace_id = ?
            AND (name LIKE ? OR brand LIKE ? OR description LIKE ? OR tags_json LIKE ?)
          ORDER BY updated_at DESC
        `).all(options.workspaceId, ...Array(4).fill(`%${options.search}%`))
      : options.search
      ? this.db.prepare(`
          SELECT * FROM products
          WHERE name LIKE ? OR brand LIKE ? OR description LIKE ? OR tags_json LIKE ?
          ORDER BY updated_at DESC
        `).all(...Array(4).fill(`%${options.search}%`))
      : options.workspaceId
        ? this.db.prepare(`
            SELECT * FROM products WHERE workspace_id = ? ORDER BY updated_at DESC
          `).all(options.workspaceId)
      : this.db.prepare("SELECT * FROM products ORDER BY updated_at DESC").all();
    const products = (rows as ProductRow[]).map(rowToProduct);
    if (!options.filter) return products.slice(0, limit);
    const filter = filterSpecSchema.parse(options.filter);
    return applyFilter(products, { ...filter, limit: Math.min(filter.limit, limit) });
  }

  getProduct(id: string, workspaceId?: string): Product | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM products WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM products WHERE id = ?").get(id)) as ProductRow | undefined;
    return row ? rowToProduct(row) : null;
  }

  getProductBySource(workspaceId: string, source: string, sourceId: string): Product | null {
    const row = this.db.prepare(`
      SELECT * FROM products WHERE workspace_id = ? AND source = ? AND source_id = ?
    `).get(workspaceId, source, sourceId) as ProductRow | undefined;
    return row ? rowToProduct(row) : null;
  }

  private existingProduct(product: NormalizedProduct): Product | null {
    return this.getProductBySource(
      product.workspaceId,
      product.source,
      product.sourceId,
    );
  }

  private collisionSafeProduct(product: NormalizedProduct, reservedIds: ReadonlySet<string> = new Set()): NormalizedProduct {
    if (!reservedIds.has(product.id) && !this.getProduct(product.id)) return product;
    const preferred = stableWorkspaceProductId(
      product.workspaceId,
      product.source,
      product.sourceId,
    );
    const fallback = stableProductId(
      `workspace:${product.workspaceId}:${product.source}`,
      product.sourceId,
    );
    const id = !reservedIds.has(preferred) && !this.getProduct(preferred) ? preferred : fallback;
    const conflicting = reservedIds.has(id) || this.getProduct(id);
    if (conflicting) {
      throw new Error(`Product ID collision for ${product.workspaceId}/${product.source}/${product.sourceId}.`);
    }
    return productSchema.parse({ ...product, id });
  }

  private writeProducts(products: NormalizedProduct[]): number {
    const statement = this.db.prepare(`
      INSERT INTO products (
        id, workspace_id, kind, source, source_id, url, brand, name, description, price, original_price,
        currency, category, color, color_family, fit, attributes_json, materials_json, tags_json,
        annotations_json, sizes_json, images_json, available, stock_status, stock_checked_at,
        price_checked_at, sizes_checked_at, decision, x, y, embedding_revision,
        scores_json, imported_at, updated_at
      ) VALUES (
        @id, @workspaceId, @kind, @source, @sourceId, @url, @brand, @name, @description, @price, @originalPrice,
        @currency, @category, @color, @colorFamily, @fit, @attributes, @materials, @tags,
        @annotations, @sizes, @images, @available, @stockStatus, @stockCheckedAt,
        @priceCheckedAt, @sizesCheckedAt, @decision, @x, @y, @embeddingRevision,
        @scores, @importedAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id, kind=excluded.kind,
        source=excluded.source, source_id=excluded.source_id,
        url=excluded.url, brand=excluded.brand, name=excluded.name,
        description=excluded.description, price=excluded.price,
        original_price=excluded.original_price, currency=excluded.currency,
        category=excluded.category, color=excluded.color,
        color_family=excluded.color_family, fit=excluded.fit, attributes_json=excluded.attributes_json,
        materials_json=excluded.materials_json, tags_json=excluded.tags_json,
        annotations_json=excluded.annotations_json, sizes_json=excluded.sizes_json,
        images_json=excluded.images_json, available=excluded.available,
        stock_status=excluded.stock_status, stock_checked_at=excluded.stock_checked_at,
        price_checked_at=excluded.price_checked_at, sizes_checked_at=excluded.sizes_checked_at,
        decision=excluded.decision, x=excluded.x, y=excluded.y,
        embedding_revision=excluded.embedding_revision,
        scores_json=excluded.scores_json, imported_at=excluded.imported_at,
        updated_at=excluded.updated_at
    `);

    this.db.transaction((records: NormalizedProduct[]) => {
      for (const product of records) statement.run(productParameters(product));
    })(products);
    for (const workspaceId of unique(products.map(
      (product) => product.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    ))) {
      syncFavoritesCompatibility(this.db, workspaceId);
    }
    return products.length;
  }

  /** Import collector data without overwriting user-owned catalog state. */
  upsertCollectedProducts(input: Product[]): number {
    const staged = new Map<string, NormalizedProduct>();
    const reservedIds = new Set<string>();
    for (const candidate of input) {
      const incoming = productSchema.parse(candidate);
      const identity = `${incoming.workspaceId}\u0000${incoming.source}\u0000${incoming.sourceId}`;
      const existing = staged.get(identity) ?? this.existingProduct(incoming);
      const parsed = existing
        ? productSchema.parse({ ...incoming, id: existing.id })
        : this.collisionSafeProduct(incoming, reservedIds);
      const next = !existing ? parsed : productSchema.parse({
          ...parsed,
          id: existing.id,
          workspaceId: existing.workspaceId,
          importedAt: existing.importedAt,
          decision: existing.decision,
          tags: unique([...(existing.tags ?? []), ...parsed.tags]),
          annotations: existing.annotations ?? {},
          scores: existing.scores,
          x: existing.x,
          y: existing.y,
          attributes: { ...existing.attributes, ...parsed.attributes },
        });
      staged.set(identity, next);
      reservedIds.add(next.id);
    }
    this.writeProducts([...staged.values()]);
    return input.length;
  }

  // Imports are collector-safe by default; user state changes through patches/decisions.
  upsertProducts(input: Product[]): number {
    return this.upsertCollectedProducts(input);
  }

  private productsInOneWorkspace(ids: string[], workspaceId?: string): {
    workspaceId: string;
    products: Product[];
  } {
    const productIds = unique(ids);
    if (productIds.length === 0) {
      return { workspaceId: workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID, products: [] };
    }
    const products = productIds.map((id) => this.getProduct(id, workspaceId));
    const missing = productIds.filter((_, index) => !products[index]);
    if (missing.length > 0) throw new Error(`Unknown or cross-workspace products: ${missing.join(", ")}`);
    const present = products as Product[];
    const workspaceIds = unique(present.map(
      (product) => product.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    ));
    if (workspaceIds.length !== 1) throw new Error("Products from multiple workspaces cannot be mutated together.");
    if (workspaceId && workspaceIds[0] !== workspaceId) {
      throw new Error(`Products do not belong to workspace ${workspaceId}.`);
    }
    return { workspaceId: workspaceIds[0]!, products: present };
  }

  patchProducts(ids: string[], patch: ProductPatch, workspaceId?: string): number {
    const parsedPatch = productPatchSchema.parse(patch);
    const productIds = unique(ids);
    const scope = this.productsInOneWorkspace(productIds, workspaceId);
    if (parsedPatch.decision !== undefined) {
      this.setDecision(productIds, parsedPatch.decision, scope.workspaceId);
    }
    const current = productIds.map((id) => this.getProduct(id, scope.workspaceId)) as Product[];
    if (!Object.keys(parsedPatch).some((key) => key !== "decision")) return current.length;
    const now = new Date().toISOString();
    const updated = current.map((product) => productSchema.parse({
      ...product,
      ...parsedPatch,
      decision: product.decision,
      tags: parsedPatch.tags ? unique([...product.tags, ...parsedPatch.tags]) : product.tags,
      annotations: parsedPatch.annotations
        ? { ...(product.annotations ?? {}), ...parsedPatch.annotations }
        : (product.annotations ?? {}),
      scores: parsedPatch.scores ? { ...product.scores, ...parsedPatch.scores } : product.scores,
      attributes: parsedPatch.attributes
        ? { ...product.attributes, ...parsedPatch.attributes }
        : product.attributes,
      updatedAt: now,
    }));
    return this.writeProducts(updated);
  }

  setDecision(ids: string[], decision: ProductDecision, workspaceId?: string): DecisionActionResult {
    const parsedDecision = decisionSchema.parse(decision);
    const scope = this.productsInOneWorkspace(ids, workspaceId);
    const products = scope.products;
    if (products.length === 0) throw new Error("At least one product is required.");
    const actionId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO decision_actions (id, workspace_id, created_at, undone_at) VALUES (?, ?, ?, NULL)
      `).run(actionId, scope.workspaceId, now);
      const addItem = this.db.prepare(`
        INSERT INTO decision_action_items (
          action_id, product_id, before_decision, after_decision
        ) VALUES (?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE products SET decision = ?, updated_at = ? WHERE id = ?
      `);
      for (const product of products) {
        addItem.run(actionId, product.id, product.decision, parsedDecision);
        update.run(parsedDecision, now, product.id);
      }
    })();
    for (const workspaceId of unique(products.map(
      (product) => product.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    ))) {
      syncFavoritesCompatibility(this.db, workspaceId);
    }
    return {
      actionId,
      products: products.map((product) => ({ ...product, decision: parsedDecision, updatedAt: now })),
    };
  }

  getDecisionAction(id: string, workspaceId?: string): DecisionActionRecord | null {
    const action = (workspaceId
      ? this.db.prepare("SELECT * FROM decision_actions WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM decision_actions WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    if (!action) return null;
    const items = this.db.prepare(`
      SELECT product_id, before_decision, after_decision
      FROM decision_action_items WHERE action_id = ? ORDER BY rowid
    `).all(id) as Record<string, unknown>[];
    return {
      id: String(action.id),
      workspaceId: String(action.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID),
      createdAt: String(action.created_at),
      undoneAt: action.undone_at ? String(action.undone_at) : null,
      items: items.map((item) => ({
        productId: String(item.product_id),
        before: decisionSchema.parse(item.before_decision),
        after: decisionSchema.parse(item.after_decision),
      })),
    };
  }

  listDecisionActions(limit = 50, workspaceId?: string): DecisionActionRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = (workspaceId
      ? this.db.prepare(`
          SELECT id FROM decision_actions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?
        `).all(workspaceId, bounded)
      : this.db.prepare(`
          SELECT id FROM decision_actions ORDER BY created_at DESC LIMIT ?
        `).all(bounded)) as { id: string }[];
    return rows.map((row) => this.getDecisionAction(row.id, workspaceId)).filter(Boolean) as DecisionActionRecord[];
  }

  undoDecision(actionId: string, workspaceId?: string): DecisionActionResult | null {
    const action = this.getDecisionAction(actionId, workspaceId);
    if (!action || action.undoneAt) return null;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const stillActive = this.db.prepare(`
        SELECT 1 FROM decision_actions WHERE id = ? AND undone_at IS NULL
      `).get(actionId);
      if (!stillActive) throw new Error(`Decision action ${actionId} was already undone.`);
      const update = this.db.prepare(`
        UPDATE products SET decision = ?, updated_at = ? WHERE id = ?
      `);
      for (const item of action.items) update.run(item.before, now, item.productId);
      this.db.prepare("UPDATE decision_actions SET undone_at = ? WHERE id = ?").run(now, actionId);
    })();
    const workspaceIds = unique(action.items
      .map((item) => this.getProduct(item.productId)?.workspaceId)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId)));
    for (const workspaceId of workspaceIds) syncFavoritesCompatibility(this.db, workspaceId);
    return {
      actionId,
      products: action.items.map((item) => this.getProduct(item.productId, action.workspaceId)).filter(Boolean) as Product[],
    };
  }

  undoLastDecision(workspaceId?: string): DecisionActionResult | null {
    const row = (workspaceId
      ? this.db.prepare(`
          SELECT id FROM decision_actions
          WHERE workspace_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1
        `).get(workspaceId)
      : this.db.prepare(`
          SELECT id FROM decision_actions WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1
        `).get()) as { id: string } | undefined;
    return row ? this.undoDecision(row.id, workspaceId) : null;
  }

  replaceCoordinates(products: Product[]): number {
    const update = this.db.prepare("UPDATE products SET x = ?, y = ? WHERE id = ?");
    this.db.transaction((records: Product[]) => {
      for (const product of records) update.run(product.x, product.y, product.id);
    })(products);
    return products.length;
  }

  saveFilter(spec: FilterSpec, workspaceId = DEFAULT_CLOTHING_WORKSPACE_ID): FilterSpec {
    const parsed = filterSpecSchema.parse(spec);
    if (!this.getWorkspace(workspaceId)) throw new Error(`Unknown workspace: ${workspaceId}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO saved_filters (
        id, workspace_id, name, description, spec_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id, name=excluded.name, description=excluded.description,
        spec_json=excluded.spec_json, updated_at=excluded.updated_at
    `).run(parsed.id, workspaceId, parsed.name, parsed.description, JSON.stringify(parsed), now, now);
    return parsed;
  }

  listFilters(workspaceId?: string): FilterSpec[] {
    const rows = (workspaceId
      ? this.db.prepare(`
          SELECT spec_json FROM saved_filters WHERE workspace_id = ? ORDER BY updated_at DESC
        `).all(workspaceId)
      : this.db.prepare("SELECT spec_json FROM saved_filters ORDER BY updated_at DESC").all()) as { spec_json: string }[];
    return rows.map((row) => filterSpecSchema.parse(parseJson(row.spec_json, {})));
  }

  deleteFilter(id: string): boolean {
    return this.db.prepare("DELETE FROM saved_filters WHERE id = ?").run(id).changes > 0;
  }

  saveView(input: {
    id: string;
    workspaceId?: string;
    name: string;
    description?: string;
    filter: FilterSpec;
    state?: JsonObject;
  }): SavedViewRecord {
    const filter = filterSpecSchema.parse(input.filter);
    const workspaceId = input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!this.getWorkspace(workspaceId)) throw new Error(`Unknown workspace: ${workspaceId}`);
    const existing = this.getView(input.id);
    if (existing && existing.workspaceId !== workspaceId) {
      throw new Error(`View ${input.id} already belongs to workspace ${existing.workspaceId}.`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO saved_views (
        id, workspace_id, name, description, filter_json, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        filter_json=excluded.filter_json, state_json=excluded.state_json,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      workspaceId,
      input.name,
      input.description ?? "",
      JSON.stringify(filter),
      JSON.stringify(input.state ?? {}),
      now,
      now,
    );
    return this.getView(input.id, workspaceId)!;
  }

  getView(id: string, workspaceId?: string): SavedViewRecord | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM saved_views WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM saved_views WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID),
      name: String(row.name),
      description: String(row.description),
      filter: filterSpecSchema.parse(parseJson(row.filter_json, {})),
      state: parseJson(row.state_json, {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listViews(workspaceId?: string): SavedViewRecord[] {
    const rows = (workspaceId
      ? this.db.prepare(`
          SELECT id FROM saved_views WHERE workspace_id = ? ORDER BY updated_at DESC
        `).all(workspaceId)
      : this.db.prepare("SELECT id FROM saved_views ORDER BY updated_at DESC").all()) as { id: string }[];
    return rows.map((row) => this.getView(row.id, workspaceId)).filter(Boolean) as SavedViewRecord[];
  }

  deleteView(id: string, workspaceId?: string): boolean {
    const view = this.getView(id, workspaceId);
    if (!view) return false;
    return this.db.prepare("DELETE FROM saved_views WHERE id = ? AND workspace_id = ?")
      .run(id, view.workspaceId).changes > 0;
  }

  createAcquisitionJob(input: {
    id?: string;
    workspaceId?: string;
    source: string;
    kind?: string;
    items?: Array<{
      id?: string;
      productId?: string | null;
      url: string;
      payload?: JsonObject;
    }>;
  }): AcquisitionJobRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const items = [...new Map((input.items ?? []).map((item) => [item.url, item])).values()];
    const productIds = items.flatMap(({ productId }) => productId ? [productId] : []);
    const workspaceId = productIds.length > 0
      ? this.productsInOneWorkspace(productIds, input.workspaceId).workspaceId
      : (input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID);
    if (!this.getWorkspace(workspaceId)) throw new Error(`Unknown workspace: ${workspaceId}`);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO acquisition_jobs (
          id, workspace_id, source, kind, status, total_items, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, workspaceId, input.source, input.kind ?? "enrichment", items.length, now, now);
      const insert = this.db.prepare(`
        INSERT INTO acquisition_job_items (
          id, job_id, product_id, url, status, attempts, payload_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      `);
      for (const item of items) {
        insert.run(
          item.id ?? randomUUID(),
          id,
          item.productId ?? null,
          item.url,
          JSON.stringify(item.payload ?? {}),
          now,
          now,
        );
      }
    })();
    return this.getAcquisitionJob(id)!;
  }

  private acquisitionJobFromRow(row: Record<string, unknown>): AcquisitionJobRecord {
    const total = Number(row.total_items);
    const succeeded = Number(row.succeeded_items);
    const failed = Number(row.failed_items);
    const blocked = Number(row.blocked_items);
    const cancelled = Number(row.cancelled_items);
    const finished = succeeded + failed + blocked + cancelled;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID),
      source: String(row.source),
      kind: String(row.kind),
      status: row.status as AcquisitionStatus,
      totalItems: total,
      succeededItems: succeeded,
      failedItems: failed,
      blockedItems: blocked,
      cancelledItems: cancelled,
      pendingItems: Math.max(0, total - finished),
      progress: total === 0 ? 0 : finished / total,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      updatedAt: String(row.updated_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    };
  }

  getAcquisitionJob(id: string, workspaceId?: string): AcquisitionJobRecord | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM acquisition_jobs WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM acquisition_jobs WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    return row ? this.acquisitionJobFromRow(row) : null;
  }

  listAcquisitionJobs(options: {
    workspaceId?: string;
    status?: AcquisitionStatus;
    limit?: number;
  } = {}): AcquisitionJobRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.status && options.workspaceId
      ? this.db.prepare(`
          SELECT * FROM acquisition_jobs
          WHERE status = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT ?
        `).all(options.status, options.workspaceId, limit)
      : options.status
      ? this.db.prepare(`
          SELECT * FROM acquisition_jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?
        `).all(options.status, limit)
      : options.workspaceId
        ? this.db.prepare(`
            SELECT * FROM acquisition_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?
          `).all(options.workspaceId, limit)
      : this.db.prepare(`
          SELECT * FROM acquisition_jobs ORDER BY updated_at DESC LIMIT ?
        `).all(limit);
    return (rows as Record<string, unknown>[]).map((row) => this.acquisitionJobFromRow(row));
  }

  listAcquisitionItems(jobId: string): AcquisitionJobItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM acquisition_job_items WHERE job_id = ? ORDER BY rowid
    `).all(jobId) as Record<string, unknown>[];
    return rows.map(acquisitionItemFromRow);
  }

  enqueueAcquisitionItems(jobId: string, items: Array<{
    id?: string;
    productId?: string | null;
    url: string;
    payload?: JsonObject;
  }>): number {
    const job = this.getAcquisitionJob(jobId);
    if (!job) throw new Error(`Unknown acquisition job: ${jobId}`);
    const productIds = items.flatMap(({ productId }) => productId ? [productId] : []);
    if (productIds.length > 0) this.productsInOneWorkspace(productIds, job.workspaceId);
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO acquisition_job_items (
        id, job_id, product_id, url, status, attempts, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `);
    const inserted = this.db.transaction(() => {
      let count = 0;
      for (const item of new Map(items.map((item) => [item.url, item])).values()) {
        count += insert.run(
          item.id ?? randomUUID(),
          jobId,
          item.productId ?? null,
          item.url,
          JSON.stringify(item.payload ?? {}),
          now,
          now,
        ).changes;
      }
      if (count > 0) {
        this.db.prepare(`
          UPDATE acquisition_jobs SET status = 'queued', error = NULL,
            finished_at = NULL, updated_at = ? WHERE id = ?
        `).run(now, jobId);
      }
      return count;
    })();
    this.refreshAcquisitionJob(jobId);
    return inserted;
  }

  updateAcquisitionJob(id: string, patch: {
    status?: AcquisitionStatus;
    error?: string | null;
  }): AcquisitionJobRecord | null {
    const current = this.getAcquisitionJob(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const now = new Date().toISOString();
    const startedAt = status === "running" ? (current.startedAt ?? now) : current.startedAt;
    const finishedAt = ["succeeded", "failed", "blocked", "cancelled"].includes(status)
      ? now
      : null;
    this.db.prepare(`
      UPDATE acquisition_jobs SET status = ?, error = ?, started_at = ?,
        updated_at = ?, finished_at = ? WHERE id = ?
    `).run(status, patch.error === undefined ? current.error : patch.error, startedAt, now, finishedAt, id);
    return this.getAcquisitionJob(id);
  }

  claimNextAcquisitionItem(jobId: string): AcquisitionJobItem | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM acquisition_job_items
        WHERE job_id = ? AND status = 'queued'
        ORDER BY rowid LIMIT 1
      `).get(jobId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      const claimed = this.db.prepare(`
        UPDATE acquisition_job_items SET status = 'running',
          last_error = NULL, updated_at = ?, finished_at = NULL
        WHERE id = ? AND status = 'queued'
      `).run(now, row.id);
      if (claimed.changes === 0) return null;
      this.db.prepare(`
        UPDATE acquisition_jobs SET status = 'running', started_at = COALESCE(started_at, ?),
          updated_at = ?, finished_at = NULL WHERE id = ?
      `).run(now, now, jobId);
      const updated = this.db.prepare(`
        SELECT * FROM acquisition_job_items WHERE id = ?
      `).get(row.id) as Record<string, unknown>;
      return acquisitionItemFromRow(updated);
    })();
  }

  recordAcquisitionItemAttempt(jobId: string, itemId: string): AcquisitionJobItem {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE acquisition_job_items SET attempts = attempts + 1, updated_at = ?
      WHERE job_id = ? AND id = ? AND status = 'running'
    `).run(now, jobId, itemId);
    if (result.changes === 0) throw new Error(`Acquisition item ${itemId} is not running.`);
    const row = this.db.prepare(`
      SELECT * FROM acquisition_job_items WHERE job_id = ? AND id = ?
    `).get(jobId, itemId) as Record<string, unknown>;
    return acquisitionItemFromRow(row);
  }

  private transitionAcquisitionItem(
    jobId: string,
    itemId: string,
    status: Extract<AcquisitionStatus, "succeeded" | "failed" | "blocked" | "cancelled">,
    patch: { productId?: string | null; payload?: JsonObject; error?: string | null } = {},
  ): AcquisitionJobRecord {
    const job = this.getAcquisitionJob(jobId);
    if (!job) throw new Error(`Unknown acquisition job: ${jobId}`);
    if (patch.productId && !this.getProduct(patch.productId, job.workspaceId)) {
      throw new Error(`Product ${patch.productId} does not belong to acquisition workspace ${job.workspaceId}.`);
    }
    const current = this.db.prepare(`
      SELECT * FROM acquisition_job_items WHERE id = ? AND job_id = ?
    `).get(itemId, jobId) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`Unknown acquisition item: ${itemId}`);
    const now = new Date().toISOString();
    const payload = patch.payload
      ? { ...parseJson<JsonObject>(current.payload_json, {}), ...patch.payload }
      : parseJson<JsonObject>(current.payload_json, {});
    this.db.prepare(`
      UPDATE acquisition_job_items SET status = ?, product_id = ?, payload_json = ?,
        last_error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND job_id = ?
    `).run(
      status,
      patch.productId === undefined ? (current.product_id ?? null) : patch.productId,
      JSON.stringify(payload),
      patch.error ?? null,
      now,
      now,
      itemId,
      jobId,
    );
    return this.refreshAcquisitionJob(jobId);
  }

  completeAcquisitionItem(jobId: string, itemId: string, patch: {
    productId?: string | null;
    payload?: JsonObject;
  } = {}): AcquisitionJobRecord {
    return this.transitionAcquisitionItem(jobId, itemId, "succeeded", patch);
  }

  failAcquisitionItem(jobId: string, itemId: string, error: string): AcquisitionJobRecord {
    return this.transitionAcquisitionItem(jobId, itemId, "failed", { error });
  }

  blockAcquisitionItem(jobId: string, itemId: string, error: string): AcquisitionJobRecord {
    return this.transitionAcquisitionItem(jobId, itemId, "blocked", { error });
  }

  cancelAcquisitionItem(jobId: string, itemId: string): AcquisitionJobRecord {
    return this.transitionAcquisitionItem(jobId, itemId, "cancelled");
  }

  cancelAcquisitionJob(id: string): AcquisitionJobRecord | null {
    if (!this.getAcquisitionJob(id)) return null;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE acquisition_job_items SET status = 'cancelled', updated_at = ?, finished_at = ?
        WHERE job_id = ? AND status IN ('queued', 'running', 'blocked')
      `).run(now, now, id);
      this.db.prepare(`
        UPDATE acquisition_jobs SET status = 'cancelled', updated_at = ?, finished_at = ?
        WHERE id = ?
      `).run(now, now, id);
    })();
    return this.refreshAcquisitionJob(id, "cancelled");
  }

  retryAcquisitionItems(jobId: string, itemIds?: string[]): number {
    if (!this.getAcquisitionJob(jobId)) throw new Error(`Unknown acquisition job: ${jobId}`);
    const now = new Date().toISOString();
    const selected = itemIds ? unique(itemIds) : [];
    const placeholders = selected.map(() => "?").join(", ");
    const result = selected.length > 0
      ? this.db.prepare(`
          UPDATE acquisition_job_items SET status = 'queued', last_error = NULL,
            updated_at = ?, finished_at = NULL
          WHERE job_id = ? AND id IN (${placeholders}) AND status IN ('failed', 'blocked')
        `).run(now, jobId, ...selected)
      : this.db.prepare(`
          UPDATE acquisition_job_items SET status = 'queued', last_error = NULL,
            updated_at = ?, finished_at = NULL
          WHERE job_id = ? AND status IN ('failed', 'blocked')
        `).run(now, jobId);
    if (result.changes > 0) {
      this.db.prepare(`
        UPDATE acquisition_jobs SET status = 'queued', error = NULL,
          updated_at = ?, finished_at = NULL WHERE id = ?
      `).run(now, jobId);
    }
    this.refreshAcquisitionJob(jobId);
    return result.changes;
  }

  private refreshAcquisitionJob(
    jobId: string,
    forcedStatus?: AcquisitionStatus,
  ): AcquisitionJobRecord {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM acquisition_job_items WHERE job_id = ?
    `).get(jobId) as Record<string, number>;
    const current = this.getAcquisitionJob(jobId);
    if (!current) throw new Error(`Unknown acquisition job: ${jobId}`);
    const total = Number(counts.total ?? 0);
    const queued = Number(counts.queued ?? 0);
    const running = Number(counts.running ?? 0);
    const succeeded = Number(counts.succeeded ?? 0);
    const failed = Number(counts.failed ?? 0);
    const blocked = Number(counts.blocked ?? 0);
    const cancelled = Number(counts.cancelled ?? 0);
    let status = forcedStatus ?? current.status;
    if (!forcedStatus) {
      if (running > 0) status = "running";
      else if (queued > 0) status = current.status === "running" ? "running" : "queued";
      else if (failed > 0) status = "failed";
      else if (blocked > 0) status = "blocked";
      else if (total > 0 && succeeded > 0) status = "succeeded";
      else if (total > 0 && cancelled === total) status = "cancelled";
      else status = "queued";
    }
    const terminal = queued === 0 && running === 0 && total > 0;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE acquisition_jobs SET status = ?, total_items = ?, succeeded_items = ?,
        failed_items = ?, blocked_items = ?, cancelled_items = ?, updated_at = ?,
        finished_at = ? WHERE id = ?
    `).run(
      status,
      total,
      succeeded,
      failed,
      blocked,
      cancelled,
      now,
      terminal ? (current.finishedAt ?? now) : null,
      jobId,
    );
    return this.getAcquisitionJob(jobId)!;
  }

  saveOutfitBoard(input: {
    id: string;
    workspaceId?: string;
    name: string;
    description?: string;
    metadata?: JsonObject;
    items?: Array<{
      productId: string;
      role?: string;
      position?: number;
      notes?: string;
    }>;
  }): OutfitBoardRecord {
    const now = new Date().toISOString();
    const items = input.items ?? [];
    const itemIds = unique(items.map((item) => item.productId));
    const workspaceId = itemIds.length > 0
      ? this.productsInOneWorkspace(itemIds, input.workspaceId).workspaceId
      : (input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID);
    if (!this.getWorkspace(workspaceId)) throw new Error(`Unknown workspace: ${workspaceId}`);
    const existing = this.getOutfitBoard(input.id);
    if (existing && existing.workspaceId !== workspaceId) {
      throw new Error(`Outfit ${input.id} already belongs to workspace ${existing.workspaceId}.`);
    }
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO outfit_boards (
          id, workspace_id, name, description, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,
          description=excluded.description, metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at
      `).run(
        input.id,
        workspaceId,
        input.name,
        input.description ?? "",
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );
      this.db.prepare("DELETE FROM outfit_board_items WHERE board_id = ?").run(input.id);
      const insert = this.db.prepare(`
        INSERT INTO outfit_board_items (
          board_id, product_id, role, position, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, index) => {
        insert.run(
          input.id,
          item.productId,
          item.role ?? "item",
          item.position ?? index,
          item.notes ?? "",
          now,
        );
      });
    })();
    syncOutfitBoardCompatibility(this.db, input.id);
    return this.getOutfitBoard(input.id)!;
  }

  getOutfitBoard(id: string, workspaceId?: string): OutfitBoardRecord | null {
    const row = (workspaceId
      ? this.db.prepare("SELECT * FROM outfit_boards WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : this.db.prepare("SELECT * FROM outfit_boards WHERE id = ?").get(id)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = this.db.prepare(`
      SELECT product_id, role, position, notes FROM outfit_board_items
      WHERE board_id = ? ORDER BY position, created_at
    `).all(id) as Record<string, unknown>[];
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID),
      name: String(row.name),
      description: String(row.description),
      metadata: parseJson(row.metadata_json, {}),
      items: items.map((item) => ({
        productId: String(item.product_id),
        role: String(item.role),
        position: Number(item.position),
        notes: String(item.notes),
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listOutfitBoards(workspaceId?: string): OutfitBoardRecord[] {
    const rows = (workspaceId
      ? this.db.prepare(`
          SELECT id FROM outfit_boards WHERE workspace_id = ? ORDER BY updated_at DESC
        `).all(workspaceId)
      : this.db.prepare(`
          SELECT id FROM outfit_boards ORDER BY updated_at DESC
        `).all()) as { id: string }[];
    return rows.map((row) => this.getOutfitBoard(row.id, workspaceId)).filter(Boolean) as OutfitBoardRecord[];
  }

  deleteOutfitBoard(id: string, workspaceId?: string): boolean {
    return this.db.transaction(() => {
      const board = this.getOutfitBoard(id, workspaceId);
      if (!board) return false;
      const deleted = this.db.prepare("DELETE FROM outfit_boards WHERE id = ?").run(id).changes > 0;
      if (deleted) {
        this.db.prepare("DELETE FROM collections WHERE system_key = ?").run(`legacy-outfit:${id}`);
      }
      return deleted;
    })();
  }

  createVisualJob(input: {
    id: string;
    workspaceId?: string;
    prompt: string;
    maxInspections: number;
    targetCount: number;
    threshold: number;
    analysisMode: "sequential" | "sheet";
    referenceImages: string[];
    constraints?: JsonObject;
    candidateIds?: string[];
  }): VisualJobRecord {
    const workspaceId = input.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    if (!this.getWorkspace(workspaceId)) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (input.candidateIds?.length) {
      const candidates = this.productsInOneWorkspace(input.candidateIds, workspaceId).products;
      const invalid = candidates.filter((product) => product.kind !== "shop").map((product) => product.id);
      if (invalid.length) throw new Error(`Invalid visual candidates: ${invalid.join(", ")}`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO visual_jobs (
        id, workspace_id, prompt, status, message, max_inspections, target_count, threshold,
        analysis_mode, reference_images_json, constraints_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      workspaceId,
      input.prompt,
      "Luna démarre sa recherche agentique…",
      input.maxInspections,
      input.targetCount,
      input.threshold,
      input.analysisMode,
      JSON.stringify(input.referenceImages),
      JSON.stringify(input.constraints ?? {}),
      now,
      now,
    );
    if (input.candidateIds) this.freezeVisualJobCandidates(input.id, input.candidateIds);
    return this.getVisualJob(input.id)!;
  }

  updateVisualJob(id: string, patch: {
    status?: VisualJobStatus;
    message?: string;
    error?: string | null;
  }): VisualJobRecord | null {
    const current = this.getVisualJob(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE visual_jobs SET status = ?, message = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.message ?? current.message,
      patch.error === null ? null : (patch.error ?? current.error ?? null),
      new Date().toISOString(),
      id,
    );
    return this.getVisualJob(id);
  }

  getVisualJob(id: string, workspaceId?: string): VisualJobRecord | null {
    const row = this.db.prepare(`
      SELECT j.*,
        (SELECT COUNT(*) FROM visual_assessments a
          JOIN products p ON p.id = a.product_id
          WHERE a.job_id = j.id AND p.workspace_id = j.workspace_id) AS inspected,
        (SELECT COUNT(*) FROM visual_assessments a
          JOIN products p ON p.id = a.product_id
          WHERE a.job_id = j.id AND p.workspace_id = j.workspace_id
            AND a.rejected = 0 AND a.score > j.threshold) AS selected,
        (SELECT COUNT(*) FROM visual_job_candidates c
          JOIN products p ON p.id = c.product_id
          WHERE c.job_id = j.id AND p.workspace_id = j.workspace_id) AS candidate_count
      FROM visual_jobs j WHERE j.id = ? AND (? IS NULL OR j.workspace_id = ?)
    `).get(id, workspaceId ?? null, workspaceId ?? null) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID),
      prompt: String(row.prompt),
      status: row.status as VisualJobStatus,
      message: String(row.message),
      maxInspections: Number(row.max_inspections),
      targetCount: Number(row.target_count),
      threshold: Number(row.threshold),
      analysisMode: row.analysis_mode === "sheet" ? "sheet" : "sequential",
      referenceImages: parseJson(row.reference_images_json, []),
      constraints: parseJson(row.constraints_json, {}),
      candidatesFrozenAt: row.candidates_frozen_at ? String(row.candidates_frozen_at) : null,
      candidateCount: Number(row.candidate_count),
      inspected: Number(row.inspected),
      selected: Number(row.selected),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listVisualJobs(limit = 50, workspaceId?: string): VisualJobRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = (workspaceId
      ? this.db.prepare(`
          SELECT id FROM visual_jobs WHERE workspace_id = ? ORDER BY updated_at DESC, id LIMIT ?
        `).all(workspaceId, bounded)
      : this.db.prepare(`
          SELECT id FROM visual_jobs ORDER BY updated_at DESC, id LIMIT ?
        `).all(bounded)) as { id: string }[];
    return rows.map(({ id }) => this.getVisualJob(id, workspaceId)).filter(Boolean) as VisualJobRecord[];
  }

  freezeVisualJobCandidates(jobId: string, productIds: string[]): number {
    const job = this.getVisualJob(jobId);
    if (!job) throw new Error(`Unknown visual job: ${jobId}`);
    const ids = unique(productIds);
    if (job.candidatesFrozenAt) {
      const frozen = this.listVisualJobCandidateIds(jobId);
      if (frozen.length === ids.length && frozen.every((id, index) => id === ids[index])) {
        return frozen.length;
      }
      throw new Error(`Visual job ${jobId} candidates are already frozen.`);
    }
    const products = ids.map((id) => this.getProduct(id, job.workspaceId));
    const invalid = ids.filter((_, index) => !products[index] || products[index]?.kind !== "shop");
    if (invalid.length > 0) throw new Error(`Invalid visual candidates: ${invalid.join(", ")}`);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO visual_job_candidates (job_id, product_id, ordinal, created_at)
        VALUES (?, ?, ?, ?)
      `);
      ids.forEach((productId, ordinal) => insert.run(jobId, productId, ordinal, now));
      this.db.prepare(`
        UPDATE visual_jobs SET candidates_frozen_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, jobId);
    })();
    return ids.length;
  }

  listVisualJobCandidateIds(jobId: string): string[] {
    const rows = this.db.prepare(`
      SELECT c.product_id FROM visual_job_candidates c
      JOIN visual_jobs j ON j.id = c.job_id
      JOIN products p ON p.id = c.product_id AND p.workspace_id = j.workspace_id
      WHERE c.job_id = ? ORDER BY c.ordinal
    `).all(jobId) as { product_id: string }[];
    return rows.map((row) => row.product_id);
  }

  listVisualJobCandidates(jobId: string): Product[] {
    const rows = this.db.prepare(`
      SELECT p.* FROM visual_job_candidates c
      JOIN visual_jobs j ON j.id = c.job_id
      JOIN products p ON p.id = c.product_id
      WHERE c.job_id = ? AND p.workspace_id = j.workspace_id ORDER BY c.ordinal
    `).all(jobId) as ProductRow[];
    return rows.map(rowToProduct);
  }

  isVisualJobCandidate(jobId: string, productId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM visual_job_candidates WHERE job_id = ? AND product_id = ?
    `).get(jobId, productId));
  }

  recordVisualAssessment(input: {
    jobId: string;
    productId: string;
    score: number;
    rejected: boolean;
    reason: string;
    signals: string[];
  }): VisualJobRecord {
    const job = this.getVisualJob(input.jobId);
    if (!job) throw new Error(`Unknown visual job: ${input.jobId}`);
    const product = this.getProduct(input.productId, job.workspaceId);
    if (!product) throw new Error(`Unknown product: ${input.productId}`);
    if (product.kind !== "shop") throw new Error("Only shop products can be recorded in a visual selection job.");
    if (job.candidatesFrozenAt && !this.isVisualJobCandidate(input.jobId, input.productId)) {
      throw new Error(`Product ${input.productId} is not a frozen candidate for visual job ${input.jobId}.`);
    }
    const existing = this.db.prepare(`
      SELECT 1 FROM visual_assessments WHERE job_id = ? AND product_id = ?
    `).get(input.jobId, input.productId);
    if (!existing && job.inspected >= job.maxInspections) {
      throw new Error(`Visual job ${input.jobId} already reached its inspection limit.`);
    }
    const score = Math.min(1, Math.max(0, input.score));
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO visual_assessments (
          job_id, product_id, score, rejected, reason, signals_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, product_id) DO UPDATE SET
          score=excluded.score, rejected=excluded.rejected, reason=excluded.reason,
          signals_json=excluded.signals_json, created_at=excluded.created_at
      `).run(
        input.jobId,
        input.productId,
        score,
        input.rejected ? 1 : 0,
        input.reason,
        JSON.stringify(input.signals),
        now,
      );
      const passing = !input.rejected && score > job.threshold;
      this.db.prepare(`
        UPDATE visual_jobs SET status = 'scoring', message = ?, updated_at = ? WHERE id = ?
      `).run(
        passing
          ? `${product.brand} · ${product.name} retenu à ${score.toFixed(2)}`
          : `${product.brand} · ${product.name} analysé à ${score.toFixed(2)}`,
        now,
        input.jobId,
      );
    })();
    return this.getVisualJob(input.jobId)!;
  }

  listVisualAssessments(jobId: string): VisualAssessment[] {
    const rows = this.db.prepare(`
      SELECT a.* FROM visual_assessments a
      JOIN visual_jobs j ON j.id = a.job_id
      JOIN products p ON p.id = a.product_id AND p.workspace_id = j.workspace_id
      WHERE a.job_id = ? ORDER BY a.score DESC, a.created_at ASC
    `).all(jobId) as Record<string, unknown>[];
    return rows.map((row) => ({
      jobId: String(row.job_id),
      productId: String(row.product_id),
      score: Number(row.score),
      rejected: Boolean(row.rejected),
      reason: String(row.reason),
      signals: parseJson(row.signals_json, []),
      createdAt: String(row.created_at),
    }));
  }

  stats(): Record<string, unknown> {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS products,
        COUNT(DISTINCT brand) AS brands,
        SUM(CASE WHEN decision = 'saved' THEN 1 ELSE 0 END) AS saved,
        SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN stock_status != 'unknown' THEN 1 ELSE 0 END) AS stockKnown
      FROM products
    `).get() as Record<string, number>;
    const categories = this.db.prepare(`
      SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY count DESC
    `).all();
    return {
      ...totals,
      categories,
      filters: this.listFilters().length,
      views: this.listViews().length,
      outfits: this.listOutfitBoards().length,
    };
  }
}
