import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import { adapterFor } from "../collector/registry";
import type { CollectedStockStatus, RawProduct } from "../collector/types";
import { productSchema, type Product } from "../src/domain/catalog";
import { fetchPublicHtml } from "./public-html";

export type AcquisitionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type AcquisitionTarget = {
  productId: string;
  url: string;
};

export type AcquisitionItemSnapshot = AcquisitionTarget & {
  id: string;
  status: AcquisitionStatus;
  attempts: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type AcquisitionJobSnapshot = {
  id: string;
  source: string;
  status: AcquisitionStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  blocked: number;
  cancelled: number;
  progress: number;
  items: AcquisitionItemSnapshot[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  error?: string;
};

export type AcquisitionClientStatus = "queued" | "running" | "complete" | "error" | "cancelled";

export type AcquisitionClientSnapshot = Omit<AcquisitionJobSnapshot, "status"> & {
  status: AcquisitionClientStatus;
  rawStatus: AcquisitionStatus;
  message: string;
  terminal: boolean;
  partial: boolean;
  canResume: boolean;
};

export type DetailFetchContext = {
  signal: AbortSignal;
};

export type DetailFetcher = {
  fetch(target: AcquisitionTarget, context: DetailFetchContext): Promise<RawProduct | null>;
  close?(): Promise<void>;
};

type EnrichedProduct = Product & {
  stockStatus?: CollectedStockStatus;
  stockCheckedAt?: string | null;
  priceCheckedAt?: string | null;
  sizesCheckedAt?: string | null;
};

export type AcquisitionRepository = {
  getProduct(id: string): Product | null;
  upsertProducts(products: Product[]): number;
  createAcquisitionJob?(input: {
    id?: string;
    source: string;
    kind?: string;
    items?: Array<{
      id?: string;
      productId?: string | null;
      url: string;
      payload?: Record<string, unknown>;
    }>;
  }): { id: string };
  updateAcquisitionJob?(id: string, patch: { status?: AcquisitionStatus; error?: string | null }): unknown;
  claimNextAcquisitionItem?(jobId: string): { id: string; url?: string } | null;
  recordAcquisitionItemAttempt?(jobId: string, itemId: string): { attempts: number };
  completeAcquisitionItem?(
    jobId: string,
    itemId: string,
    patch?: { productId?: string | null; payload?: Record<string, unknown> },
  ): unknown;
  failAcquisitionItem?(jobId: string, itemId: string, error: string): unknown;
  blockAcquisitionItem?(jobId: string, itemId: string, error: string): unknown;
  cancelAcquisitionJob?(id: string): unknown;
  cancelAcquisitionItem?(jobId: string, itemId: string): unknown;
  retryAcquisitionItems?(jobId: string, itemIds?: string[]): unknown;
  getAcquisitionJob?(id: string): {
    id: string;
    source: string;
    status: AcquisitionStatus;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    finishedAt: string | null;
  } | null;
  listAcquisitionJobs?(options?: { status?: AcquisitionStatus; limit?: number }): Array<{
    id: string;
    source: string;
    status: AcquisitionStatus;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    finishedAt: string | null;
  }>;
  listAcquisitionItems?(jobId: string): Array<{
    id: string;
    productId: string | null;
    url: string;
    status: AcquisitionStatus;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
  }>;
};

type MutableJob = AcquisitionJobSnapshot & {
  cancelRequested: boolean;
  abortController: AbortController;
};

type AcquisitionServiceOptions = {
  fetcher?: DetailFetcher;
  sameDomainDelayMs?: number;
  maxRetries?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  idFactory?: () => string;
};

export class AcquisitionBlockedError extends Error {
  override readonly name = "AcquisitionBlockedError";
}

export class AcquisitionCancelledError extends Error {
  override readonly name = "AcquisitionCancelledError";
}

export class AcquisitionFetchError extends Error {
  override readonly name = "AcquisitionFetchError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof AcquisitionCancelledError
    || (error instanceof Error && (error.name === "AbortError" || /closed|aborted/i.test(error.message)));
}

function asIso(value: string | null | undefined, fallback?: string): string | null | undefined {
  if (!value) return fallback;
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

/**
 * Merge a detail observation without turning missing retailer data into an
 * out-of-stock result. User decisions, scores and board coordinates always win.
 */
export function mergeCollectedDetail(existing: Product, raw: RawProduct, observedAt: string): Product {
  const current = existing as EnrichedProduct;
  const reliableStock = raw.stockStatus === "in_stock" || raw.stockStatus === "out_of_stock";
  const reliableSizes = Boolean(raw.sizesCheckedAt)
    || raw.attributes?.sizeAvailabilityKnown === true
    || (reliableStock && raw.stockStatus === "out_of_stock");
  const reliablePrice = raw.price !== null && raw.price !== undefined && Number.isFinite(raw.price);

  const stockStatus = reliableStock ? raw.stockStatus : current.stockStatus;
  const stockCheckedAt = reliableStock
    ? asIso(raw.stockCheckedAt, observedAt)
    : current.stockCheckedAt;
  const sizesCheckedAt = reliableSizes
    ? asIso(raw.sizesCheckedAt, observedAt)
    : current.sizesCheckedAt;
  const priceCheckedAt = reliablePrice
    ? asIso(raw.priceCheckedAt, observedAt)
    : current.priceCheckedAt;
  const rawSizes = reliableSizes ? (raw.rawSizes ?? raw.sizes ?? []) : undefined;
  const observedAttributes: Product["attributes"] = { ...raw.attributes };
  if (!reliableSizes) {
    delete observedAttributes.rawSizes;
    delete observedAttributes.sizeAvailabilityKnown;
    delete observedAttributes.sizesCheckedAt;
  }
  if (!reliableStock) {
    delete observedAttributes.stockStatus;
    delete observedAttributes.stockCheckedAt;
  }
  if (!reliablePrice) delete observedAttributes.priceCheckedAt;

  const attributes: Product["attributes"] = {
    ...existing.attributes,
    ...observedAttributes,
    ...(rawSizes ? { rawSizes } : {}),
    ...(stockStatus ? { stockStatus } : {}),
    ...(stockCheckedAt ? { stockCheckedAt } : {}),
    ...(sizesCheckedAt ? { sizesCheckedAt } : {}),
    ...(priceCheckedAt ? { priceCheckedAt } : {}),
  };

  const candidate = {
    ...existing,
    brand: nonEmpty(raw.brand, existing.brand),
    name: nonEmpty(raw.name, existing.name),
    description: nonEmpty(raw.description, existing.description),
    price: reliablePrice ? raw.price : existing.price,
    originalPrice: raw.originalPrice ?? existing.originalPrice,
    currency: nonEmpty(raw.currency, existing.currency),
    category: nonEmpty(raw.category, existing.category),
    color: nonEmpty(raw.color, existing.color),
    colorFamily: nonEmpty(raw.colorFamily, existing.colorFamily),
    fit: nonEmpty(raw.fit, existing.fit),
    materials: raw.materials?.length ? raw.materials : existing.materials,
    tags: raw.tags?.length ? [...new Set([...existing.tags, ...raw.tags])] : existing.tags,
    sizes: reliableSizes ? (raw.sizes ?? []) : existing.sizes,
    images: raw.images?.length ? raw.images : existing.images,
    available: reliableStock ? raw.stockStatus === "in_stock" : existing.available,
    attributes,
    stockStatus,
    stockCheckedAt,
    priceCheckedAt,
    sizesCheckedAt,
    // These are intentionally reasserted after retailer data.
    decision: existing.decision,
    scores: existing.scores,
    x: existing.x,
    y: existing.y,
    importedAt: existing.importedAt,
    updatedAt: observedAt,
  };
  return productSchema.parse(candidate);
}

function validateTargets(targets: AcquisitionTarget[]): AcquisitionTarget[] {
  if (targets.length === 0) throw new Error("At least one exact product ID/URL target is required.");
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  return targets.map((target) => {
    if (!target.productId.trim()) throw new Error("Every acquisition target needs a productId.");
    const url = new URL(target.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Unsupported acquisition protocol: ${url.protocol}`);
    }
    // This also rejects unregistered hosts. Generic crawling is deliberately not implicit.
    adapterFor(url, false);
    if (seenIds.has(target.productId)) throw new Error(`Duplicate acquisition product: ${target.productId}`);
    if (seenUrls.has(url.href)) throw new Error(`Duplicate acquisition URL: ${url.href}`);
    seenIds.add(target.productId);
    seenUrls.add(url.href);
    return { productId: target.productId, url: url.href };
  });
}

function publicSnapshot(job: MutableJob): AcquisitionJobSnapshot {
  const snapshot: Partial<MutableJob> = { ...job };
  delete snapshot.cancelRequested;
  delete snapshot.abortController;
  return {
    ...(snapshot as AcquisitionJobSnapshot),
    items: job.items.map((item) => ({ ...item })),
  };
}

function terminal(status: AcquisitionStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

/** Stable API representation used by every acquisition route. */
export function acquisitionClientView(job: AcquisitionJobSnapshot): AcquisitionClientSnapshot {
  const status: AcquisitionClientStatus = job.status === "succeeded"
    ? "complete"
    : job.status === "failed" || job.status === "blocked"
      ? "error"
      : job.status;
  const problem = job.items.find((item) => item.status === "failed" || item.status === "blocked")?.error;
  const message = status === "complete"
    ? `${job.succeeded}/${job.total} fiches rafraîchies`
    : status === "error"
      ? `${job.succeeded} réussie${job.succeeded === 1 ? "" : "s"}, ${job.failed + job.blocked} à reprendre`
      : status === "cancelled"
        ? `${job.succeeded} réussie${job.succeeded === 1 ? "" : "s"} avant l’arrêt`
        : `${job.completed}/${job.total} fiches vérifiées`;
  return {
    ...job,
    status,
    rawStatus: job.status,
    message,
    terminal: status === "complete" || status === "error" || status === "cancelled",
    partial: job.succeeded > 0 && status !== "complete",
    canResume: job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "blocked",
    ...(status === "error" && !job.error && problem ? { error: problem } : {}),
  };
}

export class AcquisitionService {
  private readonly fetcher: DetailFetcher;
  private readonly sameDomainDelayMs: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly jobs = new Map<string, MutableJob>();
  private readonly listeners = new Set<(job: AcquisitionJobSnapshot) => void>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly activeRuns = new Set<string>();
  private readonly lastRequestAt = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly repository: AcquisitionRepository, options: AcquisitionServiceOptions = {}) {
    this.fetcher = options.fetcher ?? new PlaywrightDetailFetcher();
    this.sameDomainDelayMs = Math.max(0, options.sameDomainDelayMs ?? 1_500);
    this.maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.idFactory = options.idFactory ?? randomUUID;
  }

  start(input: { targets: AcquisitionTarget[]; source?: string }): AcquisitionJobSnapshot {
    const targets = validateTargets(input.targets);
    for (const target of targets) {
      const product = this.repository.getProduct(target.productId);
      if (!product) throw new Error(`Unknown product: ${target.productId}`);
      if (product.url !== target.url && new URL(product.url).href !== target.url) {
        throw new Error(`Target URL does not match product ${target.productId}.`);
      }
    }
    const now = this.now().toISOString();
    const id = this.idFactory();
    const job: MutableJob = {
      id,
      source: input.source ?? "detail-enrichment",
      status: "queued",
      total: targets.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      progress: 0,
      items: targets.map((target) => ({
        ...target,
        id: this.idFactory(),
        status: "queued",
        attempts: 0,
      })),
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      abortController: new AbortController(),
    };
    this.repository.createAcquisitionJob?.({
      id,
      source: job.source,
      kind: "detail",
      items: job.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        url: item.url,
        payload: { requestedAt: now },
      })),
    });
    this.jobs.set(id, job);
    this.emit(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  get(jobId: string): AcquisitionJobSnapshot | null {
    const job = this.jobs.get(jobId) ?? this.hydrate(jobId);
    return job ? publicSnapshot(job) : null;
  }

  list(): AcquisitionJobSnapshot[] {
    for (const stored of this.repository.listAcquisitionJobs?.({ limit: 100 }) ?? []) {
      if (!this.jobs.has(stored.id)) this.hydrate(stored.id);
    }
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicSnapshot);
  }

  subscribe(listener: (job: AcquisitionJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitFor(jobId: string): Promise<AcquisitionJobSnapshot> {
    const run = this.runs.get(jobId);
    if (!run) throw new Error(`Unknown acquisition job: ${jobId}`);
    await run;
    return this.get(jobId)!;
  }

  cancel(jobId: string): AcquisitionJobSnapshot {
    const job = this.requireJob(jobId);
    if (terminal(job.status)) return publicSnapshot(job);
    job.cancelRequested = true;
    job.abortController.abort();
    for (const item of job.items) {
      if (item.status !== "queued") continue;
      item.status = "cancelled";
      item.finishedAt = this.now().toISOString();
      this.repository.cancelAcquisitionItem?.(job.id, item.id);
    }
    this.repository.cancelAcquisitionJob?.(job.id);
    this.recount(job);
    this.emit(job);
    return publicSnapshot(job);
  }

  retry(jobId: string): AcquisitionJobSnapshot {
    const job = this.requireJob(jobId);
    if (!terminal(job.status)) throw new Error(`Acquisition job ${jobId} is still active.`);
    const retryable = job.items.filter((item) => item.status === "failed" || item.status === "blocked");
    if (retryable.length === 0) throw new Error(`Acquisition job ${jobId} has no failed or blocked items to retry.`);
    const now = this.now().toISOString();
    for (const item of retryable) {
      item.status = "queued";
      delete item.error;
      delete item.startedAt;
      delete item.finishedAt;
    }
    job.status = "queued";
    job.cancelRequested = false;
    job.abortController = new AbortController();
    delete job.finishedAt;
    delete job.error;
    job.updatedAt = now;
    this.repository.retryAcquisitionItems?.(job.id, retryable.map((item) => item.id));
    this.recount(job);
    this.emit(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  /**
   * Explicitly recover work persisted by a previous process. Merely reading or
   * listing jobs never starts network activity.
   */
  resume(jobId: string): AcquisitionJobSnapshot {
    const job = this.requireJob(jobId);
    if (this.activeRuns.has(job.id)) return publicSnapshot(job);
    if (job.status === "failed" || job.status === "blocked") return this.retry(job.id);
    if (job.status === "succeeded" || job.status === "cancelled") {
      throw new Error(`Acquisition job ${jobId} is already ${job.status}.`);
    }

    const interrupted = job.items.filter((item) => item.status === "running");
    for (const item of interrupted) {
      const reason = "Interrupted by a local API restart; explicitly queued for recovery.";
      this.repository.failAcquisitionItem?.(job.id, item.id, reason);
    }
    if (interrupted.length > 0) {
      this.repository.retryAcquisitionItems?.(job.id, interrupted.map((item) => item.id));
    }
    for (const item of interrupted) {
      item.status = "queued";
      item.error = "Recovered after local API restart.";
      delete item.startedAt;
      delete item.finishedAt;
    }
    if (!job.items.some((item) => item.status === "queued")) {
      throw new Error(`Acquisition job ${jobId} has no queued or interrupted items to resume.`);
    }
    job.status = "queued";
    job.cancelRequested = false;
    job.abortController = new AbortController();
    delete job.finishedAt;
    delete job.error;
    this.repository.updateAcquisitionJob?.(job.id, { status: "queued", error: null });
    this.recount(job);
    this.emit(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  async close(): Promise<void> {
    for (const jobId of [...this.activeRuns]) {
      const job = this.jobs.get(jobId);
      if (job && !terminal(job.status)) this.cancel(job.id);
    }
    await Promise.allSettled(this.runs.values());
    await this.fetcher.close?.();
  }

  private requireJob(jobId: string): MutableJob {
    const job = this.jobs.get(jobId) ?? this.hydrate(jobId);
    if (!job) throw new Error(`Unknown acquisition job: ${jobId}`);
    return job;
  }

  private hydrate(jobId: string): MutableJob | null {
    const stored = this.repository.getAcquisitionJob?.(jobId);
    const storedItems = this.repository.listAcquisitionItems?.(jobId);
    if (!stored || !storedItems) return null;
    const items: AcquisitionItemSnapshot[] = storedItems.map((item) => ({
      id: item.id,
      productId: item.productId ?? "",
      url: item.url,
      status: item.status,
      attempts: item.attempts,
      ...(item.lastError ? { error: item.lastError } : {}),
      ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
    }));
    const completed = items.filter((item) => terminal(item.status)).length;
    const job: MutableJob = {
      id: stored.id,
      source: stored.source,
      status: stored.status,
      total: items.length,
      completed,
      succeeded: items.filter((item) => item.status === "succeeded").length,
      failed: items.filter((item) => item.status === "failed").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      cancelled: items.filter((item) => item.status === "cancelled").length,
      progress: items.length === 0 ? 1 : completed / items.length,
      items,
      createdAt: stored.createdAt,
      ...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
      ...(stored.finishedAt ? { finishedAt: stored.finishedAt } : {}),
      updatedAt: stored.updatedAt,
      ...(stored.error ? { error: stored.error } : {}),
      cancelRequested: false,
      abortController: new AbortController(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private enqueue(job: MutableJob): void {
    this.activeRuns.add(job.id);
    const run = this.queue
      .then(() => this.run(job))
      .catch((error) => {
        if (!terminal(job.status)) this.finish(job, "failed", errorMessage(error));
      })
      .finally(() => this.activeRuns.delete(job.id));
    this.queue = run.catch(() => undefined);
    this.runs.set(job.id, run);
  }

  private async run(job: MutableJob): Promise<void> {
    if (job.cancelRequested) {
      this.finish(job, "cancelled");
      return;
    }
    job.status = "running";
    job.startedAt ??= this.now().toISOString();
    this.repository.updateAcquisitionJob?.(job.id, { status: "running", error: null });
    this.emit(job);

    for (const item of job.items) {
      if (item.status !== "queued") continue;
      if (job.cancelRequested) {
        item.status = "cancelled";
        item.finishedAt = this.now().toISOString();
        this.repository.cancelAcquisitionItem?.(job.id, item.id);
        continue;
      }
      await this.runItem(job, item);
    }

    if (job.cancelRequested) this.finish(job, "cancelled");
    else if (job.items.some((item) => item.status === "failed")) {
      this.finish(job, "failed", job.items.find((item) => item.status === "failed")?.error ?? "Detail acquisition failed.");
    } else if (job.items.some((item) => item.status === "blocked")) {
      this.finish(job, "blocked", job.items.find((item) => item.status === "blocked")?.error ?? "Shop access was blocked.");
    }
    else if (job.items.every((item) => item.status === "succeeded")) this.finish(job, "succeeded");
    else this.finish(job, "failed", "The acquisition queue ended with unfinished items.");
  }

  private async runItem(job: MutableJob, item: AcquisitionItemSnapshot): Promise<void> {
    item.status = "running";
    item.startedAt = this.now().toISOString();
    this.repository.claimNextAcquisitionItem?.(job.id);
    this.emit(job);

    let retries = 0;
    while (retries <= this.maxRetries) {
      if (job.cancelRequested) {
        this.cancelRunningItem(job, item);
        return;
      }
      try {
        await this.throttle(item.url);
        item.attempts += 1;
        this.repository.recordAcquisitionItemAttempt?.(job.id, item.id);
        const raw = await this.fetcher.fetch(item, { signal: job.abortController.signal });
        if (job.cancelRequested) throw new AcquisitionCancelledError("Acquisition cancelled.");
        if (!raw) throw new AcquisitionFetchError("The shop adapter could not read this product detail page.");
        const existing = this.repository.getProduct(item.productId);
        if (!existing) throw new AcquisitionFetchError(`Product disappeared during acquisition: ${item.productId}`);
        const observedAt = this.now().toISOString();
        const merged = mergeCollectedDetail(existing, raw, observedAt);
        this.repository.upsertProducts([merged]);
        item.status = "succeeded";
        item.finishedAt = observedAt;
        delete item.error;
        this.repository.completeAcquisitionItem?.(job.id, item.id, {
          productId: item.productId,
          payload: {
            stockStatus: (merged as EnrichedProduct).stockStatus ?? null,
            stockCheckedAt: (merged as EnrichedProduct).stockCheckedAt ?? null,
            priceCheckedAt: (merged as EnrichedProduct).priceCheckedAt ?? null,
            sizesCheckedAt: (merged as EnrichedProduct).sizesCheckedAt ?? null,
          },
        });
        this.recount(job);
        this.emit(job);
        return;
      } catch (error) {
        if (job.cancelRequested || isAbortError(error)) {
          this.cancelRunningItem(job, item);
          return;
        }
        if (error instanceof AcquisitionBlockedError) {
          item.status = "blocked";
          item.error = error.message;
          item.finishedAt = this.now().toISOString();
          this.repository.blockAcquisitionItem?.(job.id, item.id, error.message);
          this.recount(job);
          this.emit(job);
          return;
        }
        item.error = errorMessage(error);
        retries += 1;
        if (retries <= this.maxRetries) {
          this.emit(job);
          continue;
        }
        item.status = "failed";
        item.finishedAt = this.now().toISOString();
        this.repository.failAcquisitionItem?.(job.id, item.id, item.error);
        this.recount(job);
        this.emit(job);
        return;
      }
    }
  }

  private cancelRunningItem(job: MutableJob, item: AcquisitionItemSnapshot): void {
    item.status = "cancelled";
    item.error = "Acquisition cancelled.";
    item.finishedAt = this.now().toISOString();
    this.repository.cancelAcquisitionItem?.(job.id, item.id);
    this.recount(job);
    this.emit(job);
  }

  private async throttle(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const now = this.now().getTime();
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const remaining = this.sameDomainDelayMs - (now - last);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequestAt.set(host, this.now().getTime());
  }

  private recount(job: MutableJob): void {
    job.succeeded = job.items.filter((item) => item.status === "succeeded").length;
    job.failed = job.items.filter((item) => item.status === "failed").length;
    job.blocked = job.items.filter((item) => item.status === "blocked").length;
    job.cancelled = job.items.filter((item) => item.status === "cancelled").length;
    job.completed = job.succeeded + job.failed + job.blocked + job.cancelled;
    job.progress = job.total === 0 ? 1 : job.completed / job.total;
    job.updatedAt = this.now().toISOString();
  }

  private finish(job: MutableJob, status: AcquisitionStatus, error?: string): void {
    job.status = status;
    job.error = error;
    job.finishedAt = this.now().toISOString();
    this.recount(job);
    this.repository.updateAcquisitionJob?.(job.id, { status, error: error ?? null });
    this.emit(job);
  }

  private emit(job: MutableJob): void {
    this.recount(job);
    const snapshot = publicSnapshot(job);
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function classifyAccessBlock(input: {
  pageUrl: string;
  status?: number;
  title?: string;
  bodyText?: string;
  hasBlockingElement?: boolean;
}): string | null {
  const { pageUrl, status, hasBlockingElement = false } = input;
  if (status === 401 || status === 403 || status === 429) {
    return `Shop access stopped with HTTP ${status}; no bypass was attempted.`;
  }
  const pathname = new URL(pageUrl).pathname.toLowerCase();
  if (/captcha|challenge|login|sign-?in|connexion|anmelden/.test(pathname)) {
    return "The shop redirected to a login or verification page; no bypass was attempted.";
  }
  const challengeText = `${input.title ?? ""}\n${input.bodyText ?? ""}`.toLowerCase();
  if (/captcha|verify (?:that )?you are human|vérifiez que vous êtes humain|access denied|just a moment|checking your browser|attention required|unusual traffic|automated requests/.test(challengeText)) {
    return "The shop displayed a CAPTCHA or access-verification page; no bypass was attempted.";
  }
  if (hasBlockingElement) {
    return "The shop requires login or CAPTCHA verification; no bypass was attempted.";
  }
  return null;
}

async function accessBlockReason(context: BrowserContext, pageUrl: string, status?: number): Promise<string | null> {
  const page = context.pages()[0];
  if (!page) return classifyAccessBlock({ pageUrl, status });
  const blockingElement = page.locator([
    'iframe[src*="captcha" i]',
    'iframe[src*="challenge" i]',
    'iframe[src*="turnstile" i]',
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    '[class*="turnstile" i]',
    '[data-sitekey]',
    'form[action*="login" i]',
    'form[action*="signin" i]',
  ].join(",")).first();
  const [title, bodyText, hasBlockingElement] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 1_000 }).then((value) => value.slice(0, 8_000)).catch(() => ""),
    blockingElement.isVisible().catch(() => false),
  ]);
  return classifyAccessBlock({ pageUrl, status, title, bodyText, hasBlockingElement });
}

export class PlaywrightDetailFetcher implements DetailFetcher {
  private browser: Browser | null = null;

  constructor(private readonly options: { headed?: boolean; timeoutMs?: number } = {}) {}

  async fetch(target: AcquisitionTarget, { signal }: DetailFetchContext): Promise<RawProduct | null> {
    if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
    const requestedUrl = new URL(target.url);
    const adapter = adapterFor(requestedUrl, false);
    if (adapter.extractDetailHtml) {
      const response = await fetchPublicHtml(requestedUrl.href, {
        signal,
        timeoutMs: this.options.timeoutMs ?? 60_000,
        allowedHost: (hostname) => adapter.allowedHosts.includes(hostname),
      });
      if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
      const currentUrl = new URL(response.url);
      const plainText = response.html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 8_000);
      const blocked = classifyAccessBlock({
        pageUrl: currentUrl.href,
        status: response.status,
        bodyText: plainText,
      });
      if (blocked) throw new AcquisitionBlockedError(blocked);
      if (!adapter.matches(currentUrl)) {
        throw new AcquisitionFetchError(`Shop redirected outside its allowed hosts to ${currentUrl.hostname}.`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AcquisitionFetchError(`Shop product page returned HTTP ${response.status}.`);
      }
      if (!response.contentType.toLocaleLowerCase().includes("html")) {
        throw new AcquisitionFetchError(`Shop product page returned ${response.contentType || "an unknown content type"}.`);
      }
      const parsed = await adapter.extractDetailHtml(response.html, currentUrl.href);
      if (parsed) return parsed;
      // Keep the existing browser reader as a fallback for client-rendered data.
    }
    this.browser ??= await chromium.launch({
      headless: !this.options.headed,
      channel: "chrome",
    });
    const context = await this.browser.newContext();
    const closeOnAbort = () => void context.close().catch(() => undefined);
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      const page = await context.newPage();
      const response = await page.goto(requestedUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: this.options.timeoutMs ?? 60_000,
      });
      if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
      const currentUrl = new URL(page.url());
      const blocked = await accessBlockReason(context, currentUrl.href, response?.status());
      if (blocked) throw new AcquisitionBlockedError(blocked);
      if (!adapter.matches(currentUrl)) {
        throw new AcquisitionFetchError(`Shop redirected outside its allowed hosts to ${currentUrl.hostname}.`);
      }
      return await adapter.extractDetail(page);
    } catch (error) {
      if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
      throw error;
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
