import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import { adapterFor, discoveryAdapterFor } from "../collector/registry";
import type {
  DiscoveryFilterApplication,
  DiscoveryIntent,
  DiscoveryListingTarget,
  RawProduct,
} from "../collector/types";
import { classifyAccessBlock } from "./acquisition";
import { fetchPublicHtml } from "./public-html";

export type DiscoveryStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type DiscoveryItemSnapshot = DiscoveryListingTarget & {
  id: string;
  status: DiscoveryStatus;
  attempts: number;
  found: number;
  accepted: number;
  duplicates: number;
  filtered: number;
  invalid: number;
  error?: string;
  skipped?: "max_items_reached";
  startedAt?: string;
  finishedAt?: string;
};

export type DiscoveryJobSnapshot = {
  id: string;
  source: DiscoveryIntent["source"];
  intent: DiscoveryIntent;
  status: DiscoveryStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  blocked: number;
  cancelled: number;
  progress: number;
  discovered: number;
  duplicates: number;
  filtered: number;
  invalid: number;
  results: RawProduct[];
  items: DiscoveryItemSnapshot[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  error?: string;
};

export type DiscoveryFetchRequest = {
  source: DiscoveryIntent["source"];
  intent: DiscoveryIntent;
  target: DiscoveryListingTarget;
  limit: number;
};

export type DiscoveryFetchContext = { signal: AbortSignal };

export type DiscoveryFetcher = {
  fetch(request: DiscoveryFetchRequest, context: DiscoveryFetchContext): Promise<RawProduct[]>;
  close?(): Promise<void>;
};

/**
 * Optional synchronous persistence boundary. A repository can store snapshots
 * as JSON without coupling discovery to the catalog/acquisition schema.
 * Merely loading a queued job never starts network work; `resume` is explicit.
 */
export type DiscoveryJobStore = {
  saveDiscoveryJob(snapshot: DiscoveryJobSnapshot): void;
  getDiscoveryJob(id: string): DiscoveryJobSnapshot | null;
  listDiscoveryJobs?(limit: number): DiscoveryJobSnapshot[];
};

const discoveryModuleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_STORED_JOB_BYTES = 16 * 1024 * 1024;

function looksLikeDiscoverySnapshot(value: unknown): value is DiscoveryJobSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiscoveryJobSnapshot>;
  const statuses: DiscoveryStatus[] = ["queued", "running", "succeeded", "failed", "blocked", "cancelled"];
  return typeof candidate.id === "string"
    && SAFE_JOB_ID.test(candidate.id)
    && (candidate.source === "zalando-ch" || candidate.source === "aboutyou-ch" || candidate.source === "aliexpress")
    && Boolean(candidate.intent && typeof candidate.intent === "object")
    && Boolean(candidate.status && statuses.includes(candidate.status))
    && Array.isArray(candidate.items)
    && candidate.items.every((item) => item && typeof item === "object" && statuses.includes(item.status))
    && Array.isArray(candidate.results)
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string";
}

/** Atomic, local JSON snapshots. Loading never schedules or resumes a job. */
export class FileDiscoveryJobStore implements DiscoveryJobStore {
  readonly rootDir: string;

  constructor(rootDir = resolve(discoveryModuleRoot, "data/discovery-jobs")) {
    this.rootDir = resolve(rootDir);
  }

  saveDiscoveryJob(snapshot: DiscoveryJobSnapshot): void {
    const path = this.jobPath(snapshot.id);
    mkdirSync(this.rootDir, { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  getDiscoveryJob(id: string): DiscoveryJobSnapshot | null {
    if (!SAFE_JOB_ID.test(id)) return null;
    try {
      const path = this.jobPath(id);
      if (statSync(path).size > MAX_STORED_JOB_BYTES) return null;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return looksLikeDiscoverySnapshot(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  listDiscoveryJobs(limit: number): DiscoveryJobSnapshot[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    let names: string[];
    try {
      names = readdirSync(this.rootDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const id = name.slice(0, -".json".length);
        const job = SAFE_JOB_ID.test(id) ? this.getDiscoveryJob(id) : null;
        return job ? [job] : [];
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, safeLimit);
  }

  private jobPath(id: string): string {
    if (!SAFE_JOB_ID.test(id)) throw new Error("Invalid discovery job ID.");
    return resolve(this.rootDir, `${id}.json`);
  }
}

export type DiscoveryServiceOptions = {
  fetcher?: DiscoveryFetcher;
  store?: DiscoveryJobStore;
  sameDomainDelayMs?: number;
  maxRetries?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  idFactory?: () => string;
  /** Catalog-level deduplication hook, in addition to per-job deduplication. */
  isKnownProduct?: (product: RawProduct, source: DiscoveryIntent["source"]) => boolean;
  /** Called only with products newly accepted into the bounded job result. */
  onProducts?: (
    products: RawProduct[],
    context: { jobId: string; intent: DiscoveryIntent },
  ) => void | Promise<void>;
};

type MutableDiscoveryJob = DiscoveryJobSnapshot & {
  cancelRequested: boolean;
  abortController: AbortController;
  resultKeys: Map<string, number>;
};

export class DiscoveryBlockedError extends Error {
  override readonly name = "DiscoveryBlockedError";
}

export class DiscoveryCancelledError extends Error {
  override readonly name = "DiscoveryCancelledError";
}

export class DiscoveryFetchError extends Error {
  override readonly name = "DiscoveryFetchError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DiscoveryCancelledError
    || (error instanceof Error && (error.name === "AbortError" || /aborted|closed/i.test(error.message)));
}

function terminal(status: DiscoveryStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

function cloneRawProduct(product: RawProduct): RawProduct {
  return {
    ...product,
    ...(product.materials ? { materials: [...product.materials] } : {}),
    ...(product.tags ? { tags: [...product.tags] } : {}),
    ...(product.rawSizes ? { rawSizes: [...product.rawSizes] } : {}),
    ...(product.sizes ? { sizes: [...product.sizes] } : {}),
    ...(product.images ? { images: [...product.images] } : {}),
    ...(product.attributes ? { attributes: { ...product.attributes } } : {}),
  };
}

function publicSnapshot(job: MutableDiscoveryJob): DiscoveryJobSnapshot {
  const snapshot: Partial<MutableDiscoveryJob> = { ...job };
  delete snapshot.cancelRequested;
  delete snapshot.abortController;
  delete snapshot.resultKeys;
  return {
    ...(snapshot as DiscoveryJobSnapshot),
    intent: { ...job.intent, sizes: job.intent.sizes ? [...job.intent.sizes] : undefined },
    results: job.results.map(cloneRawProduct),
    items: job.items.map((item) => ({
      ...item,
      appliedFilters: { ...item.appliedFilters },
    })),
  };
}

function normalizeFinitePrice(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}

export function validateDiscoveryIntent(input: DiscoveryIntent): DiscoveryIntent {
  if (!Number.isInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 200) {
    throw new Error("Discovery maxItems must be an integer between 1 and 200.");
  }
  const query = input.query?.replace(/\s+/g, " ").trim();
  const category = input.category?.replace(/\s+/g, " ").trim();
  if (query && query.length > 300) throw new Error("Discovery query is limited to 300 characters.");
  if (category && category.length > 100) throw new Error("Discovery category is limited to 100 characters.");
  const sizes = [...new Set((input.sizes ?? []).map((size) => size.trim()).filter(Boolean))];
  if (sizes.length > 10) throw new Error("Discovery accepts at most 10 size intents.");
  if (input.sizeMode !== undefined && input.sizeMode !== "any" && input.sizeMode !== "all") {
    throw new Error("Discovery sizeMode must be 'any' or 'all'.");
  }
  const minPrice = normalizeFinitePrice(input.minPrice, "minPrice");
  const maxPrice = normalizeFinitePrice(input.maxPrice, "maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new Error("Discovery minPrice cannot exceed maxPrice.");
  }
  const listingUrl = input.listingUrl ? new URL(input.listingUrl) : undefined;
  if (listingUrl && listingUrl.protocol !== "https:") {
    throw new Error(`Discovery listing URLs must use HTTPS, not ${listingUrl.protocol}`);
  }
  if (listingUrl?.username || listingUrl?.password) {
    throw new Error("Discovery listing URLs cannot contain credentials.");
  }
  const intent: DiscoveryIntent = {
    source: input.source,
    maxItems: input.maxItems,
    sizeMode: input.sizeMode ?? "any",
    ...(query ? { query } : {}),
    ...(category ? { category } : {}),
    ...(sizes.length > 0 ? { sizes } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(listingUrl ? { listingUrl: listingUrl.href } : {}),
  };
  // Resolving the adapter here rejects unknown sources before any job exists.
  discoveryAdapterFor(intent.source);
  return intent;
}

function buildTargets(intent: DiscoveryIntent): DiscoveryListingTarget[] {
  const adapter = discoveryAdapterFor(intent.source);
  const targets = adapter.discovery!.buildListingTargets(intent);
  if (targets.length === 0) throw new Error(`Discovery adapter ${adapter.id} returned no listing target.`);
  if (targets.length > 10) throw new Error(`Discovery adapter ${adapter.id} exceeded the 10-target safety cap.`);
  const seen = new Set<string>();
  return targets.map((target) => {
    const url = new URL(target.url);
    if (url.protocol !== "https:") {
      throw new Error(`Discovery listing URLs must use HTTPS, not ${url.protocol}`);
    }
    const targetAdapter = adapterFor(url, false);
    if (targetAdapter.id !== adapter.id) {
      throw new Error(`Discovery target ${url.href} does not belong to adapter ${adapter.id}.`);
    }
    if (seen.has(url.href)) throw new Error(`Duplicate discovery listing target: ${url.href}`);
    seen.add(url.href);
    return { ...target, url: url.href, appliedFilters: { ...target.appliedFilters } };
  });
}

function appliedFilterAttributes(filters: DiscoveryListingTarget["appliedFilters"]): string[] {
  return (Object.entries(filters) as Array<[string, DiscoveryFilterApplication]>).map(
    ([name, application]) => `${name}:${application}`,
  );
}

function isInPriceRange(product: RawProduct, intent: DiscoveryIntent): boolean {
  if (intent.minPrice === undefined && intent.maxPrice === undefined) return true;
  if (product.price === null || product.price === undefined || !Number.isFinite(product.price)) return false;
  if (intent.minPrice !== undefined && product.price < intent.minPrice) return false;
  return intent.maxPrice === undefined || product.price <= intent.maxPrice;
}

function isInRequestedSizeRange(
  product: RawProduct,
  intent: DiscoveryIntent,
  target: DiscoveryListingTarget,
): boolean {
  const requested = intent.sizes?.map((size) => size.trim().toUpperCase()).filter(Boolean) ?? [];
  if (!requested.length || target.appliedFilters.sizes !== "post_fetch") return true;
  if (product.attributes?.sizeAvailabilityKnown !== true || product.stockStatus !== "in_stock") return false;
  const actual = new Set((product.sizes ?? []).map((size) => size.trim().toUpperCase()));
  return (intent.sizeMode ?? "any") === "all"
    ? requested.every((size) => actual.has(size))
    : requested.some((size) => actual.has(size));
}

function isRelevantToIntent(product: RawProduct, intent: DiscoveryIntent): boolean {
  if (intent.source !== "aliexpress") return true;
  const requested = `${intent.category ?? ""} ${intent.query ?? ""}`.toLocaleLowerCase();
  const candidate = `${product.name} ${product.description ?? ""}`.toLocaleLowerCase();
  if (/collier|necklace|pendentif|pendant|halskette|\bkette\b|anhänger|jewel|bijou/.test(requested)) {
    return /collier|necklace|pendentif|pendant|halskette|\bkette\b|anhänger|amulet|médaillon|medallion/.test(candidate);
  }
  if (/bonnet|beanie|mütze|headwear|chapeau|\bhat\b|casquette|\bcap\b/.test(requested)) {
    return /bonnet|beanie|mütze|strickmütze|wollmütze|sturmhaube|balaclava|chapeau|\bhat\b|\bhut\b|casquette|\bcap\b|\bkappe\b/.test(candidate);
  }
  return true;
}

function resultKey(source: DiscoveryIntent["source"], product: RawProduct): string | null {
  const adapter = discoveryAdapterFor(source);
  if (product.sourceId?.trim()) return `${source}:id:${product.sourceId.trim()}`;
  try {
    const url = new URL(product.url);
    const canonical = adapter.discovery?.canonicalProductUrl?.(url) ?? url.href;
    return `${source}:url:${canonical}`;
  } catch {
    return null;
  }
}

function normalizeListingObservation(
  raw: RawProduct,
  intent: DiscoveryIntent,
  target: DiscoveryListingTarget,
  observedAt: string,
): RawProduct | null {
  if (!raw.name?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.url);
    const adapter = adapterFor(url, false);
    if (adapter.id !== intent.source) return null;
    const canonical = adapter.discovery?.canonicalProductUrl?.(url);
    if (canonical) url = new URL(canonical);
  } catch {
    return null;
  }
  let price = raw.price;
  let currency = raw.currency;
  if (intent.source === "aliexpress" && currency?.toUpperCase() !== "CHF") {
    price = null;
    currency = "CHF";
  }
  const requestedSizes = intent.sizes ?? [];
  const reliableListingSizes = raw.attributes?.sizeAvailabilityKnown === true
    && Boolean(raw.sizesCheckedAt)
    && (raw.stockStatus === "in_stock" || raw.stockStatus === "out_of_stock");
  return {
    ...raw,
    url: url.href,
    name: raw.name.trim(),
    category: raw.category ?? intent.category,
    price,
    currency: currency ?? "CHF",
    rawSizes: reliableListingSizes ? raw.rawSizes ?? raw.sizes ?? [] : [],
    sizes: reliableListingSizes ? raw.sizes ?? [] : [],
    stockStatus: reliableListingSizes ? raw.stockStatus : "unknown",
    stockCheckedAt: reliableListingSizes ? raw.stockCheckedAt ?? observedAt : null,
    sizesCheckedAt: reliableListingSizes ? raw.sizesCheckedAt ?? observedAt : null,
    ...(price !== null && price !== undefined && Number.isFinite(price)
      ? { priceCheckedAt: observedAt }
      : { priceCheckedAt: null }),
    attributes: {
      ...raw.attributes,
      discoveryOnly: true,
      sizeAvailabilityKnown: reliableListingSizes,
      requestedSizes,
      requestedSizeMode: intent.sizeMode ?? "any",
      discoveryFilterApplications: appliedFilterAttributes(target.appliedFilters),
      ...(target.matchedSizeIntent ? { listingMatchedSizeIntents: [target.matchedSizeIntent] } : {}),
    },
    available: reliableListingSizes ? raw.stockStatus === "in_stock" : undefined,
  };
}

function mergeDuplicateObservation(existing: RawProduct, observed: RawProduct): RawProduct {
  const previousMatches = existing.attributes?.listingMatchedSizeIntents;
  const currentMatches = observed.attributes?.listingMatchedSizeIntents;
  const matches = [...new Set([
    ...(Array.isArray(previousMatches) ? previousMatches : []),
    ...(Array.isArray(currentMatches) ? currentMatches : []),
  ].filter((value): value is string => typeof value === "string"))];
  return {
    ...existing,
    price: existing.price ?? observed.price,
    originalPrice: existing.originalPrice ?? observed.originalPrice,
    images: [...new Set([...(existing.images ?? []), ...(observed.images ?? [])])],
    attributes: {
      ...existing.attributes,
      ...(matches.length > 0 ? { listingMatchedSizeIntents: matches } : {}),
    },
  };
}

export class DiscoveryService {
  private readonly fetcher: DiscoveryFetcher;
  private readonly store?: DiscoveryJobStore;
  private readonly sameDomainDelayMs: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly isKnownProduct?: DiscoveryServiceOptions["isKnownProduct"];
  private readonly onProducts?: DiscoveryServiceOptions["onProducts"];
  private readonly jobs = new Map<string, MutableDiscoveryJob>();
  private readonly listeners = new Set<(job: DiscoveryJobSnapshot) => void>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly activeRuns = new Set<string>();
  private readonly lastRequestAt = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DiscoveryServiceOptions = {}) {
    this.fetcher = options.fetcher ?? new PlaywrightDiscoveryFetcher();
    this.store = options.store;
    this.sameDomainDelayMs = Math.max(0, options.sameDomainDelayMs ?? 1_500);
    this.maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.idFactory = options.idFactory ?? randomUUID;
    this.isKnownProduct = options.isKnownProduct;
    this.onProducts = options.onProducts;
  }

  start(input: { intent: DiscoveryIntent }): DiscoveryJobSnapshot {
    const intent = validateDiscoveryIntent(input.intent);
    return this.startValidated(intent, buildTargets(intent));
  }

  startBatch(input: { intents: DiscoveryIntent[] }): DiscoveryJobSnapshot[] {
    if (input.intents.length === 0) throw new Error("At least one bounded discovery intent is required.");
    if (input.intents.length > 10) throw new Error("A discovery batch is limited to 10 intents.");
    const prepared = input.intents.map(validateDiscoveryIntent).map((intent) => ({
      intent,
      targets: buildTargets(intent),
    }));
    return prepared.map(({ intent, targets }) => this.startValidated(intent, targets));
  }

  get(jobId: string): DiscoveryJobSnapshot | null {
    const job = this.jobs.get(jobId) ?? this.hydrate(jobId);
    return job ? publicSnapshot(job) : null;
  }

  list(limit = 100): DiscoveryJobSnapshot[] {
    for (const stored of this.store?.listDiscoveryJobs?.(Math.min(Math.max(limit, 1), 100)) ?? []) {
      if (!this.jobs.has(stored.id)) this.hydrateSnapshot(stored);
    }
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(publicSnapshot);
  }

  subscribe(listener: (job: DiscoveryJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitFor(jobId: string): Promise<DiscoveryJobSnapshot> {
    const run = this.runs.get(jobId);
    if (run) await run;
    const job = this.get(jobId);
    if (!job) throw new Error(`Unknown discovery job: ${jobId}`);
    if (!terminal(job.status)) throw new Error(`Discovery job ${jobId} is persisted but has not been resumed.`);
    return job;
  }

  cancel(jobId: string): DiscoveryJobSnapshot {
    const job = this.requireJob(jobId);
    if (terminal(job.status)) return publicSnapshot(job);
    job.cancelRequested = true;
    job.abortController.abort();
    const now = this.now().toISOString();
    for (const item of job.items) {
      if (item.status !== "queued") continue;
      item.status = "cancelled";
      item.finishedAt = now;
    }
    this.recount(job);
    this.emit(job);
    return publicSnapshot(job);
  }

  retry(jobId: string): DiscoveryJobSnapshot {
    const job = this.requireJob(jobId);
    if (!terminal(job.status)) throw new Error(`Discovery job ${jobId} is still active.`);
    const retryable = job.items.filter((item) => item.status === "failed" || item.status === "blocked");
    if (retryable.length === 0) throw new Error(`Discovery job ${jobId} has no failed or blocked listing to retry.`);
    for (const item of retryable) {
      item.status = "queued";
      item.found = 0;
      item.accepted = 0;
      item.duplicates = 0;
      item.filtered = 0;
      item.invalid = 0;
      delete item.error;
      delete item.startedAt;
      delete item.finishedAt;
      delete item.skipped;
    }
    this.prepareForRun(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  /** Explicitly resumes persisted queued/running work; reading never crawls. */
  resume(jobId: string): DiscoveryJobSnapshot {
    const job = this.requireJob(jobId);
    if (this.activeRuns.has(job.id)) return publicSnapshot(job);
    if (job.status === "failed" || job.status === "blocked") return this.retry(job.id);
    if (terminal(job.status)) throw new Error(`Discovery job ${jobId} is already ${job.status}.`);
    for (const item of job.items) {
      if (item.status !== "running") continue;
      item.status = "queued";
      item.error = "Recovered after local process restart.";
      delete item.startedAt;
      delete item.finishedAt;
    }
    if (!job.items.some((item) => item.status === "queued")) {
      throw new Error(`Discovery job ${jobId} has no queued or interrupted listing to resume.`);
    }
    this.prepareForRun(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  async close(): Promise<void> {
    for (const jobId of [...this.activeRuns]) {
      const job = this.jobs.get(jobId);
      if (job && !terminal(job.status)) this.cancel(jobId);
    }
    await Promise.allSettled(this.runs.values());
    await this.fetcher.close?.();
  }

  private startValidated(
    intent: DiscoveryIntent,
    targets: DiscoveryListingTarget[],
  ): DiscoveryJobSnapshot {
    const now = this.now().toISOString();
    const job: MutableDiscoveryJob = {
      id: this.idFactory(),
      source: intent.source,
      intent,
      status: "queued",
      total: targets.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      progress: 0,
      discovered: 0,
      duplicates: 0,
      filtered: 0,
      invalid: 0,
      results: [],
      items: targets.map((target) => ({
        ...target,
        id: this.idFactory(),
        status: "queued",
        attempts: 0,
        found: 0,
        accepted: 0,
        duplicates: 0,
        filtered: 0,
        invalid: 0,
      })),
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      abortController: new AbortController(),
      resultKeys: new Map(),
    };
    this.jobs.set(job.id, job);
    this.emit(job);
    this.enqueue(job);
    return publicSnapshot(job);
  }

  private requireJob(jobId: string): MutableDiscoveryJob {
    const job = this.jobs.get(jobId) ?? this.hydrate(jobId);
    if (!job) throw new Error(`Unknown discovery job: ${jobId}`);
    return job;
  }

  private hydrate(jobId: string): MutableDiscoveryJob | null {
    const snapshot = this.store?.getDiscoveryJob(jobId);
    return snapshot ? this.hydrateSnapshot(snapshot) : null;
  }

  private hydrateSnapshot(snapshot: DiscoveryJobSnapshot): MutableDiscoveryJob {
    const existing = this.jobs.get(snapshot.id);
    if (existing) return existing;
    const job: MutableDiscoveryJob = {
      ...snapshot,
      intent: validateDiscoveryIntent(snapshot.intent),
      results: snapshot.results.map(cloneRawProduct),
      items: snapshot.items.map((item) => ({ ...item, appliedFilters: { ...item.appliedFilters } })),
      cancelRequested: false,
      abortController: new AbortController(),
      resultKeys: new Map(),
    };
    job.results.forEach((product, index) => {
      const key = resultKey(job.source, product);
      if (key) job.resultKeys.set(key, index);
    });
    this.jobs.set(job.id, job);
    return job;
  }

  private prepareForRun(job: MutableDiscoveryJob): void {
    job.status = "queued";
    job.cancelRequested = false;
    job.abortController = new AbortController();
    delete job.finishedAt;
    delete job.error;
    this.recount(job);
    this.emit(job);
  }

  private enqueue(job: MutableDiscoveryJob): void {
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

  private async run(job: MutableDiscoveryJob): Promise<void> {
    if (job.cancelRequested) {
      this.finish(job, "cancelled");
      return;
    }
    job.status = "running";
    job.startedAt ??= this.now().toISOString();
    this.emit(job);
    for (const item of job.items) {
      if (item.status !== "queued") continue;
      if (job.cancelRequested) {
        item.status = "cancelled";
        item.finishedAt = this.now().toISOString();
        continue;
      }
      if (job.results.length >= job.intent.maxItems) {
        item.status = "succeeded";
        item.skipped = "max_items_reached";
        item.finishedAt = this.now().toISOString();
        this.emit(job);
        continue;
      }
      await this.runItem(job, item);
    }
    if (job.cancelRequested) this.finish(job, "cancelled");
    else if (job.items.some((item) => item.status === "failed")) {
      this.finish(job, "failed", job.items.find((item) => item.status === "failed")?.error ?? "Discovery failed.");
    } else if (job.items.some((item) => item.status === "blocked")) {
      this.finish(job, "blocked", job.items.find((item) => item.status === "blocked")?.error ?? "Shop access was blocked.");
    } else if (job.items.every((item) => item.status === "succeeded")) this.finish(job, "succeeded");
    else this.finish(job, "failed", "The discovery queue ended with unfinished listings.");
  }

  private async runItem(job: MutableDiscoveryJob, item: DiscoveryItemSnapshot): Promise<void> {
    item.status = "running";
    item.startedAt = this.now().toISOString();
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
        const remaining = Math.max(1, job.intent.maxItems - job.results.length);
        const products = await this.fetcher.fetch({
          source: job.source,
          intent: job.intent,
          target: item,
          limit: remaining,
        }, { signal: job.abortController.signal });
        if (job.cancelRequested) throw new DiscoveryCancelledError("Discovery cancelled.");
        item.found = products.length;
        const newlyAccepted: RawProduct[] = [];
        const newlyAcceptedKeys: string[] = [];
        const resultCountBeforeFetch = job.results.length;
        for (const raw of products) {
          if (job.results.length >= job.intent.maxItems) break;
          const observed = normalizeListingObservation(raw, job.intent, item, this.now().toISOString());
          if (!observed) {
            item.invalid += 1;
            continue;
          }
          if (!isInPriceRange(observed, job.intent)) {
            item.filtered += 1;
            continue;
          }
          if (!isInRequestedSizeRange(observed, job.intent, item)) {
            item.filtered += 1;
            continue;
          }
          if (!isRelevantToIntent(observed, job.intent)) {
            item.filtered += 1;
            continue;
          }
          const key = resultKey(job.source, observed);
          if (!key) {
            item.invalid += 1;
            continue;
          }
          const existingIndex = job.resultKeys.get(key);
          if (existingIndex !== undefined) {
            job.results[existingIndex] = mergeDuplicateObservation(job.results[existingIndex]!, observed);
            item.duplicates += 1;
            continue;
          }
          if (this.isKnownProduct?.(observed, job.source)) {
            item.duplicates += 1;
            continue;
          }
          job.resultKeys.set(key, job.results.length);
          job.results.push(observed);
          newlyAccepted.push(observed);
          newlyAcceptedKeys.push(key);
          item.accepted += 1;
        }
        if (newlyAccepted.length > 0) {
          try {
            await this.onProducts?.(newlyAccepted.map(cloneRawProduct), {
              jobId: job.id,
              intent: { ...job.intent, sizes: job.intent.sizes ? [...job.intent.sizes] : undefined },
            });
          } catch (error) {
            // Do not let a failed catalog sink turn into a false successful
            // retry through the service's own result-key deduplication.
            job.results.splice(resultCountBeforeFetch);
            for (const key of newlyAcceptedKeys) job.resultKeys.delete(key);
            item.accepted -= newlyAccepted.length;
            throw error;
          }
        }
        item.status = "succeeded";
        item.finishedAt = this.now().toISOString();
        delete item.error;
        this.recount(job);
        this.emit(job);
        return;
      } catch (error) {
        if (job.cancelRequested || isAbortError(error)) {
          this.cancelRunningItem(job, item);
          return;
        }
        if (error instanceof DiscoveryBlockedError) {
          item.status = "blocked";
          item.error = error.message;
          item.finishedAt = this.now().toISOString();
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
        this.recount(job);
        this.emit(job);
        return;
      }
    }
  }

  private cancelRunningItem(job: MutableDiscoveryJob, item: DiscoveryItemSnapshot): void {
    item.status = "cancelled";
    item.error = "Discovery cancelled.";
    item.finishedAt = this.now().toISOString();
    this.recount(job);
    this.emit(job);
  }

  private async throttle(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const current = this.now().getTime();
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const remaining = this.sameDomainDelayMs - (current - last);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequestAt.set(host, this.now().getTime());
  }

  private recount(job: MutableDiscoveryJob): void {
    job.succeeded = job.items.filter((item) => item.status === "succeeded").length;
    job.failed = job.items.filter((item) => item.status === "failed").length;
    job.blocked = job.items.filter((item) => item.status === "blocked").length;
    job.cancelled = job.items.filter((item) => item.status === "cancelled").length;
    job.completed = job.succeeded + job.failed + job.blocked + job.cancelled;
    job.progress = job.total === 0 ? 1 : job.completed / job.total;
    job.discovered = job.results.length;
    job.duplicates = job.items.reduce((sum, item) => sum + item.duplicates, 0);
    job.filtered = job.items.reduce((sum, item) => sum + item.filtered, 0);
    job.invalid = job.items.reduce((sum, item) => sum + item.invalid, 0);
    job.updatedAt = this.now().toISOString();
  }

  private finish(job: MutableDiscoveryJob, status: DiscoveryStatus, error?: string): void {
    job.status = status;
    job.error = error;
    job.finishedAt = this.now().toISOString();
    this.recount(job);
    this.emit(job);
  }

  private emit(job: MutableDiscoveryJob): void {
    this.recount(job);
    const snapshot = publicSnapshot(job);
    this.store?.saveDiscoveryJob(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}

async function discoveryAccessBlockReason(
  context: BrowserContext,
  pageUrl: string,
  source: DiscoveryIntent["source"],
  status?: number,
): Promise<string | null> {
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
  const input = { pageUrl, status, title, bodyText, hasBlockingElement };
  return discoveryAdapterFor(source).discovery?.classifyAccessBlock?.(input)
    ?? classifyAccessBlock(input);
}

export class PlaywrightDiscoveryFetcher implements DiscoveryFetcher {
  private browser: Browser | null = null;
  private readonly headed: boolean;
  private readonly maxScrolls: number;

  constructor(options: { headed?: boolean; maxScrolls?: number } = {}) {
    this.headed = options.headed ?? false;
    this.maxScrolls = Math.min(5, Math.max(0, options.maxScrolls ?? 2));
  }

  async fetch(request: DiscoveryFetchRequest, context: DiscoveryFetchContext): Promise<RawProduct[]> {
    if (context.signal.aborted) throw new DiscoveryCancelledError("Discovery cancelled.");
    const requestedAdapter = adapterFor(new URL(request.target.url), false);
    if (requestedAdapter.id !== request.source) {
      throw new DiscoveryFetchError(`Listing target does not match the ${request.source} adapter.`);
    }
    if (requestedAdapter.extractListingHtml) {
      const response = await fetchPublicHtml(request.target.url, {
        signal: context.signal,
        allowedHost: (hostname) => requestedAdapter.allowedHosts.includes(hostname),
      });
      const finalUrl = new URL(response.url);
      if (!requestedAdapter.matches(finalUrl)) {
        throw new DiscoveryFetchError(`Listing redirected outside the ${request.source} adapter.`);
      }
      const plainText = response.html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 8_000);
      const block = requestedAdapter.discovery?.classifyAccessBlock?.({
        pageUrl: finalUrl.href,
        status: response.status,
        bodyText: plainText,
      }) ?? classifyAccessBlock({ pageUrl: finalUrl.href, status: response.status, bodyText: plainText });
      if (block) throw new DiscoveryBlockedError(block);
      if (response.status < 200 || response.status >= 300) {
        throw new DiscoveryFetchError(`Shop listing returned HTTP ${response.status}.`);
      }
      if (!response.contentType.toLocaleLowerCase().includes("html")) {
        throw new DiscoveryFetchError(`Shop listing returned ${response.contentType || "an unknown content type"}.`);
      }
      const products = await requestedAdapter.extractListingHtml(response.html, finalUrl.href);
      if (products.length > 0) {
        return products.slice(0, Math.min(600, Math.max(request.limit, request.limit * 3)));
      }
      // A healthy but unstructured response may still be hydrated client-side.
      // Only then do we pay for an isolated Playwright navigation.
    }
    const browser = await this.getBrowser();
    const browserContext = await browser.newContext({ locale: "fr-CH", timezoneId: "Europe/Zurich" });
    const closeOnAbort = () => { void browserContext.close().catch(() => undefined); };
    context.signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      const page = await browserContext.newPage();
      const response = await page.goto(request.target.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const finalUrl = page.url();
      const firstBlock = await discoveryAccessBlockReason(
        browserContext,
        finalUrl,
        request.source,
        response?.status(),
      );
      if (firstBlock) throw new DiscoveryBlockedError(firstBlock);

      const selector = request.source === "zalando-ch"
        ? 'article a[href*=".html"]'
        : request.source === "aboutyou-ch"
          ? 'a[href*="/p/"]'
          : 'a[href*="/item/"][href*=".html"]';
      await page.locator(selector).first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
      for (let index = 0; index < this.maxScrolls; index += 1) {
        if (context.signal.aborted) throw new DiscoveryCancelledError("Discovery cancelled.");
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(450);
      }
      const blockAfterHydration = await discoveryAccessBlockReason(browserContext, page.url(), request.source);
      if (blockAfterHydration) throw new DiscoveryBlockedError(blockAfterHydration);
      const adapter = adapterFor(new URL(page.url()), false);
      if (adapter.id !== request.source) {
        throw new DiscoveryFetchError(`Listing redirected outside the ${request.source} adapter.`);
      }
      const products = await adapter.extractListing(page);
      // A small over-read gives local price/catalog deduplication room while
      // remaining firmly bounded and never following pagination automatically.
      return products.slice(0, Math.min(600, Math.max(request.limit, request.limit * 3)));
    } finally {
      context.signal.removeEventListener("abort", closeOnAbort);
      await browserContext.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({ headless: !this.headed, channel: "chrome" });
    return this.browser;
  }
}
