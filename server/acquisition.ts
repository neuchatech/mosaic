import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright";
import { adapterFor } from "../collector/registry";
import type { CollectedStockStatus, RawProduct } from "../collector/types";
import { productSchema, type Product } from "../src/domain/catalog";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";
import { fetchPublicHtml, parseRetryAfter } from "./public-html";
import {
  preferBrowserForShop,
  sharedShopBrowser,
  shopPrefersBrowser,
} from "./shop-browser";

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
  workspaceId: string;
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
  cooldownUntil?: string;
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
  getProduct(id: string, workspaceId?: string): Product | null;
  upsertProducts(products: Product[]): number;
  createAcquisitionJob?(input: {
    id?: string;
    workspaceId?: string;
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
    workspaceId?: string;
    source: string;
    status: AcquisitionStatus;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    finishedAt: string | null;
  } | null;
  listAcquisitionJobs?(options?: {
    workspaceId?: string;
    status?: AcquisitionStatus;
    limit?: number;
  }): Array<{
    id: string;
    workspaceId?: string;
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
  sameDomainJitterMs?: number;
  rateLimitCooldownMs?: number;
  maxRateLimitRetries?: number;
  maxRetries?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  idFactory?: () => string;
};

export class AcquisitionBlockedError extends Error {
  override readonly name = "AcquisitionBlockedError";

  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
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

function cooldownDeadline(...messages: Array<string | null | undefined>): string | undefined {
  for (const message of messages) {
    const match = message?.match(/(?:paused|cooldown active) until\s+([^\s;]+)/i);
    if (!match?.[1]) continue;
    const candidate = match[1].replace(/[.,;]+$/, "");
    if (!Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  return undefined;
}

function productPriority(product: Product | null): [number, number, number, string] {
  if (!product) return [2, 2, 0, ""];
  const decisionRank = product.decision === "saved" ? 0 : 1;
  const priceRank = product.price !== null && product.price <= 200 ? 0 : product.price === null ? 1 : 2;
  const score = Math.max(0, ...Object.values(product.scores).filter(Number.isFinite));
  return [decisionRank, priceRank, -score, product.importedAt];
}

/** Share pacing across localized hosts such as fr.zalando.ch and www.zalando.ch. */
export function shopRequestKey(url: string): string {
  const parsed = new URL(url);
  try {
    return adapterFor(parsed, false).id;
  } catch {
    return parsed.hostname;
  }
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
  const parsedCooldown = job.cooldownUntil ?? cooldownDeadline(job.error, ...job.items.map((item) => item.error));
  const cooldownUntil = parsedCooldown && Date.parse(parsedCooldown) > Date.now() ? parsedCooldown : undefined;
  const message = status === "complete"
    ? `${job.succeeded}/${job.total} fiches rafraîchies`
    : status === "error"
      ? `${job.succeeded} réussie${job.succeeded === 1 ? "" : "s"}, ${job.failed + job.blocked} à reprendre`
      : status === "cancelled"
        ? `${job.succeeded} réussie${job.succeeded === 1 ? "" : "s"} avant l’arrêt`
        : cooldownUntil && Date.parse(cooldownUntil) > Date.now()
          ? "Pause Zalando — reprise automatique"
          : `${job.completed}/${job.total} fiches vérifiées`;
  return {
    ...job,
    status,
    rawStatus: job.status,
    message,
    terminal: status === "complete" || status === "error" || status === "cancelled",
    partial: job.succeeded > 0 && status !== "complete",
    canResume: job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "blocked",
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(status === "error" && !job.error && problem ? { error: problem } : {}),
  };
}

export class AcquisitionService {
  private readonly fetcher: DetailFetcher;
  private readonly sameDomainDelayMs: number;
  private readonly sameDomainJitterMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private readonly jobs = new Map<string, MutableJob>();
  private readonly listeners = new Set<(job: AcquisitionJobSnapshot) => void>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly activeRuns = new Set<string>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly blockedHostsUntil = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly repository: AcquisitionRepository, options: AcquisitionServiceOptions = {}) {
    this.fetcher = options.fetcher ?? new PlaywrightDetailFetcher();
    this.sameDomainDelayMs = Math.max(0, options.sameDomainDelayMs ?? 5_000);
    this.sameDomainJitterMs = Math.max(0, options.sameDomainJitterMs ?? 0);
    this.rateLimitCooldownMs = Math.max(0, options.rateLimitCooldownMs ?? 5 * 60_000);
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? 12);
    this.maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Share a request timestamp from the listing collector. The following detail
   * page then observes the same per-shop delay instead of starting a second,
   * independent burst immediately after discovery.
   */
  noteShopRequest(url: string, observedAt = this.now().getTime()): void {
    const host = shopRequestKey(url);
    const previous = this.lastRequestAt.get(host) ?? 0;
    this.lastRequestAt.set(host, Math.max(previous, observedAt));
  }

  start(input: {
    targets: AcquisitionTarget[];
    workspaceId?: string;
    source?: string;
  }): AcquisitionJobSnapshot {
    const targets = validateTargets(input.targets);
    if (input.source === "size-enrichment") this.prioritizeTargets(targets);
    const products = targets.map((target) => this.repository.getProduct(target.productId, input.workspaceId));
    const missing = targets.filter((_, index) => !products[index]).map(({ productId }) => productId);
    if (missing.length > 0) throw new Error(`Unknown or cross-workspace products: ${missing.join(", ")}`);
    const workspaceIds = [...new Set((products as Product[]).map(
      (product) => product.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
    ))];
    if (workspaceIds.length !== 1) {
      throw new Error("An acquisition job cannot span multiple workspaces.");
    }
    const workspaceId = input.workspaceId ?? workspaceIds[0] ?? DEFAULT_CLOTHING_WORKSPACE_ID;
    for (const [index, target] of targets.entries()) {
      const product = products[index]!;
      if (product.url !== target.url && new URL(product.url).href !== target.url) {
        throw new Error(`Target URL does not match product ${target.productId}.`);
      }
    }
    const now = this.now().toISOString();
    const id = this.idFactory();
    const job: MutableJob = {
      id,
      workspaceId,
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
      workspaceId,
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

  list(workspaceId?: string): AcquisitionJobSnapshot[] {
    for (const stored of this.repository.listAcquisitionJobs?.({ workspaceId, limit: 100 }) ?? []) {
      if (!this.jobs.has(stored.id)) this.hydrate(stored.id);
    }
    return [...this.jobs.values()]
      .filter((job) => !workspaceId || job.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicSnapshot);
  }

  /**
   * Recover only the newest persisted size scan. Cooldowns are restored and
   * waited out; CAPTCHA/login blocks remain manual and are never retried here.
   */
  recoverLatestSizeEnrichment(): AcquisitionJobSnapshot | null {
    const stored = (this.repository.listAcquisitionJobs?.({ limit: 100 }) ?? [])
      .filter((job) => job.source === "size-enrichment")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .find((job) => job.status === "queued" || job.status === "running"
        || (job.status === "blocked" && /(?:HTTP 429|rate-limit cooldown)/i.test(job.error ?? "")));
    if (!stored || this.activeRuns.has(stored.id)) return stored ? this.get(stored.id) : null;
    const job = this.requireJob(stored.id);
    const deadline = cooldownDeadline(job.error, ...job.items.map((item) => item.error));
    if (deadline) {
      job.cooldownUntil = deadline;
      const blockedUntil = Date.parse(deadline);
      for (const item of job.items) {
        if (item.status === "queued" || item.status === "running" || item.status === "blocked") {
          this.blockedHostsUntil.set(shopRequestKey(item.url), blockedUntil);
        }
      }
    }
    try {
      return job.status === "blocked" ? this.retry(job.id) : this.resume(job.id);
    } catch {
      return publicSnapshot(job);
    }
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
    if (job.source === "size-enrichment") this.prioritizeItems(job.items);
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
    if (job.source === "size-enrichment") this.prioritizeItems(job.items);
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
      workspaceId: stored.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID,
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
      ...(cooldownDeadline(stored.error, ...items.map((item) => item.error))
        ? { cooldownUntil: cooldownDeadline(stored.error, ...items.map((item) => item.error)) }
        : {}),
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
        if (!terminal(job.status)) this.finish(job, error instanceof AcquisitionBlockedError ? "blocked" : "failed", errorMessage(error));
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
    let rateLimitRetries = 0;
    while (retries <= this.maxRetries) {
      if (job.cancelRequested) {
        this.cancelRunningItem(job, item);
        return;
      }
      try {
        await this.throttle(item.url, job.abortController.signal);
        item.attempts += 1;
        this.repository.recordAcquisitionItemAttempt?.(job.id, item.id);
        const raw = await this.fetcher.fetch(item, { signal: job.abortController.signal });
        if (job.cancelRequested) throw new AcquisitionCancelledError("Acquisition cancelled.");
        if (!raw) throw new AcquisitionFetchError("The shop adapter could not read this product detail page.");
        const existing = this.repository.getProduct(item.productId, job.workspaceId);
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
          if (/HTTP 429/i.test(error.message) && rateLimitRetries < this.maxRateLimitRetries) {
            const host = shopRequestKey(item.url);
            const exponential = this.rateLimitCooldownMs * (2 ** rateLimitRetries);
            const cooldownMs = Math.min(30 * 60_000, Math.max(0, error.retryAfterMs ?? exponential));
            const blockedUntil = this.now().getTime() + cooldownMs;
            this.blockedHostsUntil.set(host, blockedUntil);
            rateLimitRetries += 1;
            item.error = `${error.message} Paused until ${new Date(blockedUntil).toISOString()}.`;
            job.error = item.error;
            job.cooldownUntil = new Date(blockedUntil).toISOString();
            this.repository.updateAcquisitionJob?.(job.id, { status: "running", error: item.error });
            this.emit(job);
            try {
              await this.waitUntil(blockedUntil, job.abortController.signal);
            } catch {
              this.cancelRunningItem(job, item);
              return;
            }
            delete job.cooldownUntil;
            delete job.error;
            this.repository.updateAcquisitionJob?.(job.id, { status: "running", error: null });
            continue;
          }
          item.status = "blocked";
          item.error = error.message;
          item.finishedAt = this.now().toISOString();
          if (/HTTP 429/i.test(error.message)) {
            this.blockedHostsUntil.set(shopRequestKey(item.url), this.now().getTime() + this.rateLimitCooldownMs);
          }
          this.repository.blockAcquisitionItem?.(job.id, item.id, error.message);
          this.recount(job);
          this.emit(job);
          // A shop-level block applies to the whole domain, not just this
          // product. Leave the remaining items queued for an explicit resume
          // instead of repeating the same rejected request dozens of times.
          throw error;
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

  private async throttle(url: string, signal: AbortSignal): Promise<void> {
    const host = shopRequestKey(url);
    const blockedUntil = this.blockedHostsUntil.get(host) ?? 0;
    if (blockedUntil > this.now().getTime()) await this.waitUntil(blockedUntil, signal);
    if (blockedUntil && blockedUntil <= this.now().getTime()) this.blockedHostsUntil.delete(host);
    const now = this.now().getTime();
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const jitter = Math.round(this.random() * this.sameDomainJitterMs);
      const remaining = this.sameDomainDelayMs + jitter - (now - last);
      if (remaining > 0) await this.waitDelay(remaining, signal);
    }
    this.lastRequestAt.set(host, this.now().getTime());
  }

  private async waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    while (deadline > this.now().getTime()) {
      await this.waitDelay(deadline - this.now().getTime(), signal);
    }
  }

  private async waitDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(new AcquisitionCancelledError("Acquisition cancelled during shop cooldown.")));
      signal.addEventListener("abort", onAbort, { once: true });
      void this.sleep(milliseconds).then(() => finish(resolve), (error) => finish(() => reject(error)));
    });
  }

  private prioritizeTargets(targets: AcquisitionTarget[]): void {
    targets.sort((left, right) => this.compareProducts(left.productId, right.productId));
  }

  private prioritizeItems(items: AcquisitionItemSnapshot[]): void {
    items.sort((left, right) => this.compareProducts(left.productId, right.productId));
  }

  private compareProducts(leftId: string, rightId: string): number {
    const left = productPriority(this.repository.getProduct(leftId));
    const right = productPriority(this.repository.getProduct(rightId));
    for (let index = 0; index < left.length; index += 1) {
      const leftValue = left[index]!;
      const rightValue = right[index]!;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    return leftId.localeCompare(rightId);
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
  private readonly browserSession;

  constructor(private readonly options: { headed?: boolean; timeoutMs?: number } = {}) {
    this.browserSession = sharedShopBrowser(options.headed ?? false);
  }

  async fetch(target: AcquisitionTarget, { signal }: DetailFetchContext): Promise<RawProduct | null> {
    if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
    const requestedUrl = new URL(target.url);
    const adapter = adapterFor(requestedUrl, false);
    if (adapter.extractDetailHtml && !shopPrefersBrowser(requestedUrl.href)) {
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
      if (blocked && (response.status === 403 || response.status === 429)) {
        preferBrowserForShop(requestedUrl.href);
        if (response.status === 429) {
          throw new AcquisitionBlockedError(blocked, response.retryAfterMs);
        }
        // Retry through the persistent browser after the service's normal
        // per-domain delay. A browser refusal remains a terminal block.
        throw new AcquisitionFetchError("The stateless reader received HTTP 403; retrying once with the persistent browser session.");
      }
      if (blocked) throw new AcquisitionBlockedError(blocked, response.retryAfterMs);
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
    return this.browserSession.withPage(signal, async (page, context) => {
      try {
      const response = await page.goto(requestedUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: this.options.timeoutMs ?? 60_000,
      });
      if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
      const currentUrl = new URL(page.url());
      const blocked = await accessBlockReason(context, currentUrl.href, response?.status());
      if (blocked) {
        preferBrowserForShop(requestedUrl.href);
        throw new AcquisitionBlockedError(
          blocked,
          parseRetryAfter(response?.headers()["retry-after"] ?? null),
        );
      }
      if (!adapter.matches(currentUrl)) {
        throw new AcquisitionFetchError(`Shop redirected outside its allowed hosts to ${currentUrl.hostname}.`);
      }
      if (adapter.extractDetailHtml) {
        // Several shops inject the authoritative Product/ProductGroup JSON-LD
        // shortly after DOMContentLoaded. Waiting for that public structured
        // payload is faster and more stable than clicking size controls.
        await page.waitForFunction(() => Array.from(
          document.querySelectorAll('script[type="application/ld+json"]'),
        ).some((node) => /"@type"\s*:\s*"Product(?:Group)?"/.test(node.textContent ?? "")), undefined, {
          timeout: Math.min(8_000, this.options.timeoutMs ?? 60_000),
        }).catch(() => undefined);
      }
      return await adapter.extractDetail(page);
      } catch (error) {
        if (signal.aborted) throw new AcquisitionCancelledError("Acquisition cancelled.");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.browserSession.close();
  }
}
