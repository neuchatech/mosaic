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
import { getDatabase } from "./database";

type ProductRow = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type NormalizedProduct = ReturnType<typeof productSchema.parse>;

export type DecisionActionResult = { actionId: string; products: Product[] };

export type DecisionActionRecord = {
  id: string;
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

function rowToProduct(row: ProductRow): Product {
  return productSchema.parse({
    id: row.id,
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
  constructor(private readonly db: Database.Database = getDatabase()) {}

  listProducts(options: { search?: string; filter?: FilterSpec; limit?: number } = {}): Product[] {
    const limit = Math.min(Math.max(options.limit ?? 5000, 0), 10_000);
    const rows = options.search
      ? this.db.prepare(`
          SELECT * FROM products
          WHERE name LIKE ? OR brand LIKE ? OR description LIKE ? OR tags_json LIKE ?
          ORDER BY updated_at DESC
        `).all(...Array(4).fill(`%${options.search}%`))
      : this.db.prepare("SELECT * FROM products ORDER BY updated_at DESC").all();
    const products = (rows as ProductRow[]).map(rowToProduct);
    if (!options.filter) return products.slice(0, limit);
    const filter = filterSpecSchema.parse(options.filter);
    return applyFilter(products, { ...filter, limit: Math.min(filter.limit, limit) });
  }

  getProduct(id: string): Product | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
    return row ? rowToProduct(row) : null;
  }

  private existingProduct(product: NormalizedProduct): Product | null {
    const row = this.db.prepare(`
      SELECT * FROM products WHERE id = ? OR (source = ? AND source_id = ?) LIMIT 1
    `).get(product.id, product.source, product.sourceId) as ProductRow | undefined;
    return row ? rowToProduct(row) : null;
  }

  private writeProducts(products: NormalizedProduct[]): number {
    const statement = this.db.prepare(`
      INSERT INTO products (
        id, kind, source, source_id, url, brand, name, description, price, original_price,
        currency, category, color, color_family, fit, attributes_json, materials_json, tags_json,
        annotations_json, sizes_json, images_json, available, stock_status, stock_checked_at,
        price_checked_at, sizes_checked_at, decision, x, y, scores_json, imported_at, updated_at
      ) VALUES (
        @id, @kind, @source, @sourceId, @url, @brand, @name, @description, @price, @originalPrice,
        @currency, @category, @color, @colorFamily, @fit, @attributes, @materials, @tags,
        @annotations, @sizes, @images, @available, @stockStatus, @stockCheckedAt,
        @priceCheckedAt, @sizesCheckedAt, @decision, @x, @y, @scores, @importedAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, source=excluded.source, source_id=excluded.source_id,
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
        scores_json=excluded.scores_json, imported_at=excluded.imported_at,
        updated_at=excluded.updated_at
    `);

    this.db.transaction((records: NormalizedProduct[]) => {
      for (const product of records) statement.run(productParameters(product));
    })(products);
    return products.length;
  }

  /** Import collector data without overwriting user-owned catalog state. */
  upsertCollectedProducts(input: Product[]): number {
    const products = input.map((candidate) => {
      const parsed = productSchema.parse(candidate);
      const existing = this.existingProduct(parsed);
      if (!existing) return parsed;
      return productSchema.parse({
        ...parsed,
        id: existing.id,
        importedAt: existing.importedAt,
        decision: existing.decision,
        tags: unique([...(existing.tags ?? []), ...parsed.tags]),
        annotations: existing.annotations ?? {},
        scores: existing.scores,
        x: existing.x,
        y: existing.y,
        attributes: { ...existing.attributes, ...parsed.attributes },
      });
    });
    return this.writeProducts(products);
  }

  // Imports are collector-safe by default; user state changes through patches/decisions.
  upsertProducts(input: Product[]): number {
    return this.upsertCollectedProducts(input);
  }

  patchProducts(ids: string[], patch: ProductPatch): number {
    const parsedPatch = productPatchSchema.parse(patch);
    const productIds = unique(ids);
    if (parsedPatch.decision !== undefined) this.setDecision(productIds, parsedPatch.decision);
    const current = productIds.map((id) => this.getProduct(id)).filter(Boolean) as Product[];
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

  setDecision(ids: string[], decision: ProductDecision): DecisionActionResult {
    const parsedDecision = decisionSchema.parse(decision);
    const products = unique(ids).map((id) => this.getProduct(id)).filter(Boolean) as Product[];
    const actionId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO decision_actions (id, created_at, undone_at) VALUES (?, ?, NULL)
      `).run(actionId, now);
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
    return {
      actionId,
      products: products.map((product) => ({ ...product, decision: parsedDecision, updatedAt: now })),
    };
  }

  getDecisionAction(id: string): DecisionActionRecord | null {
    const action = this.db.prepare("SELECT * FROM decision_actions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!action) return null;
    const items = this.db.prepare(`
      SELECT product_id, before_decision, after_decision
      FROM decision_action_items WHERE action_id = ? ORDER BY rowid
    `).all(id) as Record<string, unknown>[];
    return {
      id: String(action.id),
      createdAt: String(action.created_at),
      undoneAt: action.undone_at ? String(action.undone_at) : null,
      items: items.map((item) => ({
        productId: String(item.product_id),
        before: decisionSchema.parse(item.before_decision),
        after: decisionSchema.parse(item.after_decision),
      })),
    };
  }

  listDecisionActions(limit = 50): DecisionActionRecord[] {
    const rows = this.db.prepare(`
      SELECT id FROM decision_actions ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)) as { id: string }[];
    return rows.map((row) => this.getDecisionAction(row.id)).filter(Boolean) as DecisionActionRecord[];
  }

  undoDecision(actionId: string): DecisionActionResult | null {
    const action = this.getDecisionAction(actionId);
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
    return {
      actionId,
      products: action.items.map((item) => this.getProduct(item.productId)).filter(Boolean) as Product[],
    };
  }

  undoLastDecision(): DecisionActionResult | null {
    const row = this.db.prepare(`
      SELECT id FROM decision_actions WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.undoDecision(row.id) : null;
  }

  replaceCoordinates(products: Product[]): number {
    const update = this.db.prepare("UPDATE products SET x = ?, y = ? WHERE id = ?");
    this.db.transaction((records: Product[]) => {
      for (const product of records) update.run(product.x, product.y, product.id);
    })(products);
    return products.length;
  }

  saveFilter(spec: FilterSpec): FilterSpec {
    const parsed = filterSpecSchema.parse(spec);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO saved_filters (id, name, description, spec_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        spec_json=excluded.spec_json, updated_at=excluded.updated_at
    `).run(parsed.id, parsed.name, parsed.description, JSON.stringify(parsed), now, now);
    return parsed;
  }

  listFilters(): FilterSpec[] {
    const rows = this.db.prepare("SELECT spec_json FROM saved_filters ORDER BY updated_at DESC").all() as { spec_json: string }[];
    return rows.map((row) => filterSpecSchema.parse(parseJson(row.spec_json, {})));
  }

  deleteFilter(id: string): boolean {
    return this.db.prepare("DELETE FROM saved_filters WHERE id = ?").run(id).changes > 0;
  }

  saveView(input: {
    id: string;
    name: string;
    description?: string;
    filter: FilterSpec;
    state?: JsonObject;
  }): SavedViewRecord {
    const filter = filterSpecSchema.parse(input.filter);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO saved_views (
        id, name, description, filter_json, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        filter_json=excluded.filter_json, state_json=excluded.state_json,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      input.name,
      input.description ?? "",
      JSON.stringify(filter),
      JSON.stringify(input.state ?? {}),
      now,
      now,
    );
    return this.getView(input.id)!;
  }

  getView(id: string): SavedViewRecord | null {
    const row = this.db.prepare("SELECT * FROM saved_views WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      filter: filterSpecSchema.parse(parseJson(row.filter_json, {})),
      state: parseJson(row.state_json, {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listViews(): SavedViewRecord[] {
    const rows = this.db.prepare("SELECT id FROM saved_views ORDER BY updated_at DESC").all() as { id: string }[];
    return rows.map((row) => this.getView(row.id)).filter(Boolean) as SavedViewRecord[];
  }

  deleteView(id: string): boolean {
    return this.db.prepare("DELETE FROM saved_views WHERE id = ?").run(id).changes > 0;
  }

  createAcquisitionJob(input: {
    id?: string;
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
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO acquisition_jobs (
          id, source, kind, status, total_items, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, input.source, input.kind ?? "enrichment", items.length, now, now);
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

  getAcquisitionJob(id: string): AcquisitionJobRecord | null {
    const row = this.db.prepare("SELECT * FROM acquisition_jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.acquisitionJobFromRow(row) : null;
  }

  listAcquisitionJobs(options: { status?: AcquisitionStatus; limit?: number } = {}): AcquisitionJobRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.status
      ? this.db.prepare(`
          SELECT * FROM acquisition_jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?
        `).all(options.status, limit)
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
    if (!this.getAcquisitionJob(jobId)) throw new Error(`Unknown acquisition job: ${jobId}`);
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
    const missing = unique(items.map((item) => item.productId))
      .filter((productId) => !this.getProduct(productId));
    if (missing.length > 0) throw new Error(`Unknown outfit products: ${missing.join(", ")}`);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO outfit_boards (
          id, name, description, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,
          description=excluded.description, metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at
      `).run(
        input.id,
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
    return this.getOutfitBoard(input.id)!;
  }

  getOutfitBoard(id: string): OutfitBoardRecord | null {
    const row = this.db.prepare("SELECT * FROM outfit_boards WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = this.db.prepare(`
      SELECT product_id, role, position, notes FROM outfit_board_items
      WHERE board_id = ? ORDER BY position, created_at
    `).all(id) as Record<string, unknown>[];
    return {
      id: String(row.id),
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

  listOutfitBoards(): OutfitBoardRecord[] {
    const rows = this.db.prepare(`
      SELECT id FROM outfit_boards ORDER BY updated_at DESC
    `).all() as { id: string }[];
    return rows.map((row) => this.getOutfitBoard(row.id)).filter(Boolean) as OutfitBoardRecord[];
  }

  deleteOutfitBoard(id: string): boolean {
    return this.db.prepare("DELETE FROM outfit_boards WHERE id = ?").run(id).changes > 0;
  }

  createVisualJob(input: {
    id: string;
    prompt: string;
    maxInspections: number;
    targetCount: number;
    threshold: number;
    analysisMode: "sequential" | "sheet";
    referenceImages: string[];
    constraints?: JsonObject;
    candidateIds?: string[];
  }): VisualJobRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO visual_jobs (
        id, prompt, status, message, max_inspections, target_count, threshold,
        analysis_mode, reference_images_json, constraints_json, created_at, updated_at
      ) VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
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

  getVisualJob(id: string): VisualJobRecord | null {
    const row = this.db.prepare(`
      SELECT j.*,
        (SELECT COUNT(*) FROM visual_assessments a WHERE a.job_id = j.id) AS inspected,
        (SELECT COUNT(*) FROM visual_assessments a
          WHERE a.job_id = j.id AND a.rejected = 0 AND a.score > j.threshold) AS selected,
        (SELECT COUNT(*) FROM visual_job_candidates c WHERE c.job_id = j.id) AS candidate_count
      FROM visual_jobs j WHERE j.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
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
    const products = ids.map((id) => this.getProduct(id));
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
      SELECT product_id FROM visual_job_candidates WHERE job_id = ? ORDER BY ordinal
    `).all(jobId) as { product_id: string }[];
    return rows.map((row) => row.product_id);
  }

  listVisualJobCandidates(jobId: string): Product[] {
    const rows = this.db.prepare(`
      SELECT p.* FROM visual_job_candidates c
      JOIN products p ON p.id = c.product_id
      WHERE c.job_id = ? ORDER BY c.ordinal
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
    const product = this.getProduct(input.productId);
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
      SELECT * FROM visual_assessments WHERE job_id = ? ORDER BY score DESC, created_at ASC
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
