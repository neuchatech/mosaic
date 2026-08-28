import type Database from "better-sqlite3";
import { applyFilter } from "../src/domain/filter";
import {
  filterSpecSchema,
  productSchema,
  type FilterSpec,
  type Product,
  type ProductPatch,
} from "../src/domain/catalog";
import { getDatabase } from "./database";

type ProductRow = Record<string, unknown>;

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
    sizes: parseJson(row.sizes_json, []),
    images: parseJson(row.images_json, []),
    available: Boolean(row.available),
    decision: row.decision,
    x: row.x,
    y: row.y,
    scores: parseJson(row.scores_json, {}),
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  });
}

export class CatalogRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  listProducts(options: { search?: string; filter?: FilterSpec; limit?: number } = {}): Product[] {
    const limit = Math.min(options.limit ?? 5000, 10_000);
    const rows = options.search
      ? this.db.prepare(`
          SELECT * FROM products
          WHERE name LIKE ? OR brand LIKE ? OR description LIKE ? OR tags_json LIKE ?
          ORDER BY updated_at DESC LIMIT ?
        `).all(...Array(4).fill(`%${options.search}%`), limit)
      : this.db.prepare("SELECT * FROM products ORDER BY updated_at DESC LIMIT ?").all(limit);
    const products = (rows as ProductRow[]).map(rowToProduct);
    return options.filter ? applyFilter(products, options.filter) : products;
  }

  getProduct(id: string): Product | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
    return row ? rowToProduct(row) : null;
  }

  upsertProducts(input: Product[]): number {
    const products = input.map((product) => productSchema.parse(product));
    const statement = this.db.prepare(`
      INSERT INTO products (
        id, kind, source, source_id, url, brand, name, description, price, original_price,
        currency, category, color, color_family, fit, attributes_json, materials_json, tags_json,
        sizes_json, images_json, available, decision, x, y, scores_json, imported_at, updated_at
      ) VALUES (
        @id, @kind, @source, @sourceId, @url, @brand, @name, @description, @price, @originalPrice,
        @currency, @category, @color, @colorFamily, @fit, @attributes, @materials, @tags,
        @sizes, @images, @available, @decision, @x, @y, @scores, @importedAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, url=excluded.url, brand=excluded.brand, name=excluded.name,
        description=excluded.description, price=excluded.price,
        original_price=excluded.original_price, currency=excluded.currency,
        category=excluded.category, color=excluded.color,
        color_family=excluded.color_family, fit=excluded.fit, attributes_json=excluded.attributes_json,
        materials_json=excluded.materials_json, tags_json=excluded.tags_json,
        sizes_json=excluded.sizes_json, images_json=excluded.images_json,
        available=excluded.available, decision=excluded.decision, x=excluded.x, y=excluded.y,
        scores_json=excluded.scores_json, updated_at=excluded.updated_at
    `);

    this.db.transaction((records: Product[]) => {
      for (const product of records) {
        statement.run({
          ...product,
          originalPrice: product.originalPrice,
          attributes: JSON.stringify(product.attributes),
          materials: JSON.stringify(product.materials),
          tags: JSON.stringify(product.tags),
          sizes: JSON.stringify(product.sizes),
          images: JSON.stringify(product.images),
          scores: JSON.stringify(product.scores),
          available: product.available ? 1 : 0,
        });
      }
    })(products);
    return products.length;
  }

  patchProducts(ids: string[], patch: ProductPatch): number {
    const current = ids.map((id) => this.getProduct(id)).filter(Boolean) as Product[];
    const now = new Date().toISOString();
    const updated = current.map((product) => ({
      ...product,
      ...patch,
      tags: patch.tags ? [...new Set([...product.tags, ...patch.tags])] : product.tags,
      scores: patch.scores ? { ...product.scores, ...patch.scores } : product.scores,
      attributes: patch.attributes ? { ...product.attributes, ...patch.attributes } : product.attributes,
      updatedAt: now,
    }));
    return this.upsertProducts(updated);
  }

  replaceCoordinates(products: Product[]): number {
    const update = this.db.prepare("UPDATE products SET x = ?, y = ?, updated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    this.db.transaction((records: Product[]) => {
      for (const product of records) update.run(product.x, product.y, now, product.id);
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
    return rows.map((row) => filterSpecSchema.parse(JSON.parse(row.spec_json)));
  }

  createVisualJob(input: {
    id: string;
    prompt: string;
    maxInspections: number;
    targetCount: number;
    threshold: number;
    analysisMode: "sequential" | "sheet";
    referenceImages: string[];
  }): VisualJobRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO visual_jobs (
        id, prompt, status, message, max_inspections, target_count, threshold,
        analysis_mode, reference_images_json, created_at, updated_at
      ) VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.prompt,
      "Luna démarre sa recherche agentique…",
      input.maxInspections,
      input.targetCount,
      input.threshold,
      input.analysisMode,
      JSON.stringify(input.referenceImages),
      now,
      now,
    );
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
        COUNT(a.product_id) AS inspected,
        COALESCE(SUM(CASE WHEN a.rejected = 0 AND a.score > j.threshold THEN 1 ELSE 0 END), 0) AS selected
      FROM visual_jobs j
      LEFT JOIN visual_assessments a ON a.job_id = j.id
      WHERE j.id = ?
      GROUP BY j.id
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
      inspected: Number(row.inspected),
      selected: Number(row.selected),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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
      this.patchProducts([input.productId], {
        scores: { visual_match: Math.round(score * 100) },
        attributes: {
          visual_reason: input.reason,
          visual_signals: input.signals,
          visual_prompt: job.prompt,
          visual_rejected: input.rejected,
          visual_job_id: input.jobId,
        },
      });
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
        SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM products
    `).get() as Record<string, number>;
    const categories = this.db.prepare(`
      SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY count DESC
    `).all();
    return { ...totals, categories, filters: this.listFilters().length };
  }
}
