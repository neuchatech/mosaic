import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCatalogMedia } from "../../server/media";
import { fetchPublicBytes } from "../../server/public-html";
import { normalizePublicHttpsUrl } from "../../server/public-network";
import {
  VISUAL_EMBEDDING_SCHEMA_VERSION,
  type VisualEmbeddingItemKind,
  type VisualModelSpec,
} from "./types";

const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const sha256 = /^[a-f0-9]{64}$/;

type CachedImageRecord = {
  schemaVersion: typeof VISUAL_EMBEDDING_SCHEMA_VERSION;
  sourceHash: string;
  sourceLabel: string;
  contentHash: string;
  byteLength: number;
  contentType?: string;
  fileName: string;
  cachedAt: string;
};

type CachedEmbeddingRecord = {
  schemaVersion: typeof VISUAL_EMBEDDING_SCHEMA_VERSION;
  model: VisualModelSpec;
  contentHash: string;
  dimension: number;
  vector: number[];
  cachedAt: string;
};

export type CachedImage = {
  path: string;
  contentHash: string;
  byteLength: number;
  contentType?: string;
  cacheHit: boolean;
};

export type ImageLoadResult = {
  bytes: Uint8Array;
  contentType?: string;
};

export type VisualImageSourceContext = {
  itemId: string;
  kind?: VisualEmbeddingItemKind;
};

export type ImageSourceLoader = (
  source: string,
  options: { signal?: AbortSignal; maxBytes: number; context?: VisualImageSourceContext },
) => Promise<ImageLoadResult>;

export type VisualEmbeddingCacheOptions = {
  rootDir: string;
  imageLoader?: ImageSourceLoader;
  maxImageBytes?: number;
};

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLabel(source: string): string {
  if (source.startsWith("data:")) return `data:sha256:${hash(source)}`;
  return source.slice(0, 2_000);
}

function isFiniteVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

type AuthorizedImageSource =
  | { kind: "catalog-media"; source: string; itemId: string; fileName: string }
  | { kind: "public-https"; source: string };

function authorizeImageSource(source: string, context?: VisualImageSourceContext): AuthorizedImageSource {
  const candidate = source.trim();
  const mediaUrl = /^\/api\/media\/([^/?#]+)\/([1-6]\.(?:jpg|png|webp))$/.exec(candidate);
  if (mediaUrl) {
    if (context?.kind !== "owned" && context?.kind !== "reference") {
      throw new Error("Local catalog media requires explicit owned/reference item context.");
    }
    let itemId: string;
    try {
      itemId = decodeURIComponent(mediaUrl[1]!);
    } catch {
      throw new Error("Invalid catalog media URL.");
    }
    if (itemId !== context.itemId) throw new Error("Catalog media does not belong to this item.");
    return {
      kind: "catalog-media",
      source: candidate,
      itemId,
      fileName: mediaUrl[2]!,
    };
  }
  if (context?.kind === "owned" || context?.kind === "reference") {
    throw new Error("Owned and reference embeddings require matching app-owned catalog media.");
  }
  const safeUrl = normalizePublicHttpsUrl(candidate);
  if (!safeUrl) throw new Error("Visual shop images require a public HTTPS URL.");
  return { kind: "public-https", source: safeUrl };
}

/** Validate and canonicalize before cache lookup as well as before I/O. */
export function normalizeVisualImageSource(source: string, context?: VisualImageSourceContext): string {
  return authorizeImageSource(source, context).source;
}

export const defaultImageSourceLoader: ImageSourceLoader = async (source, options) => {
  const authorized = authorizeImageSource(source, options.context);
  let result: ImageLoadResult;
  if (authorized.kind === "catalog-media") {
    result = { bytes: await readCatalogMedia(authorized.itemId, authorized.fileName, options.maxBytes) };
  } else {
    const response = await fetchPublicBytes(authorized.source, {
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: 20_000,
      maxBytes: options.maxBytes,
      accept: "image/avif,image/webp,image/jpeg,image/png",
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`Image download failed (HTTP ${response.status}).`);
    const contentType = response.contentType.toLocaleLowerCase().split(";", 1)[0]?.trim();
    if (!contentType || !["image/avif", "image/webp", "image/jpeg", "image/png"].includes(contentType)) {
      throw new Error(`Image download returned ${response.contentType || "an unsupported content type"}.`);
    }
    result = { bytes: response.body, contentType };
  }
  if (result.bytes.byteLength === 0) throw new Error("Image payload is empty.");
  if (result.bytes.byteLength > options.maxBytes) throw new Error(`Image exceeds ${options.maxBytes} bytes.`);
  return result;
};

export function modelFingerprint(model: VisualModelSpec): string {
  return hash(`${model.id}\u0000${model.revision}\u0000${model.dtype}`);
}

export class VisualEmbeddingCache {
  readonly rootDir: string;
  private readonly imageLoader: ImageSourceLoader;
  private readonly maxImageBytes: number;

  constructor(options: VisualEmbeddingCacheOptions) {
    this.rootDir = resolve(options.rootDir);
    this.imageLoader = options.imageLoader ?? defaultImageSourceLoader;
    const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Visual image byte limit must be an integer between 1 and ${MAX_IMAGE_BYTES}.`);
    }
    this.maxImageBytes = maxImageBytes;
  }

  async getImage(
    source: string,
    options: { force?: boolean; signal?: AbortSignal; context?: VisualImageSourceContext } = {},
  ): Promise<CachedImage> {
    const safeSource = normalizeVisualImageSource(source, options.context);
    const sourceHash = hash(safeSource);
    if (!options.force) {
      const cached = await this.getCachedImage(safeSource, { context: options.context });
      if (cached) return cached;
    }

    const loaded = await this.imageLoader(safeSource, {
      signal: options.signal,
      maxBytes: this.maxImageBytes,
      context: options.context,
    });
    const contentHash = hash(loaded.bytes);
    const fileName = `${contentHash}.img`;
    const imagePath = join(this.rootDir, "images", fileName);
    try {
      const imageStat = await lstat(imagePath);
      if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size !== loaded.bytes.byteLength) {
        await atomicWrite(imagePath, loaded.bytes);
      }
    } catch {
      await atomicWrite(imagePath, loaded.bytes);
    }
    const record: CachedImageRecord = {
      schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
      sourceHash,
      sourceLabel: sourceLabel(safeSource),
      contentHash,
      byteLength: loaded.bytes.byteLength,
      ...(loaded.contentType ? { contentType: loaded.contentType } : {}),
      fileName,
      cachedAt: new Date().toISOString(),
    };
    const recordPath = join(this.rootDir, "sources", `${sourceHash}.json`);
    await atomicWrite(recordPath, `${JSON.stringify(record)}\n`);
    return {
      path: imagePath,
      contentHash,
      byteLength: loaded.bytes.byteLength,
      contentType: loaded.contentType,
      cacheHit: false,
    };
  }

  async getCachedImage(
    source: string,
    options: { context?: VisualImageSourceContext } = {},
  ): Promise<CachedImage | null> {
    const safeSource = normalizeVisualImageSource(source, options.context);
    const sourceHash = hash(safeSource);
    const recordPath = join(this.rootDir, "sources", `${sourceHash}.json`);
    const record = await readJson<CachedImageRecord>(recordPath);
    if (record?.schemaVersion !== VISUAL_EMBEDDING_SCHEMA_VERSION || record.sourceHash !== sourceHash) return null;
    if (!sha256.test(record.contentHash) || record.fileName !== `${record.contentHash}.img`) return null;
    if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 1 || record.byteLength > this.maxImageBytes) return null;
    const imagePath = join(this.rootDir, "images", record.fileName);
    try {
      const imageStat = await lstat(imagePath);
      if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size !== record.byteLength) return null;
      return {
        path: imagePath,
        contentHash: record.contentHash,
        byteLength: record.byteLength,
        contentType: record.contentType,
        cacheHit: true,
      };
    } catch {
      return null;
    }
  }

  async getEmbedding(model: VisualModelSpec, contentHash: string): Promise<number[] | null> {
    if (!sha256.test(contentHash)) return null;
    const path = this.embeddingPath(model, contentHash);
    const record = await readJson<CachedEmbeddingRecord>(path);
    if (!record || record.schemaVersion !== VISUAL_EMBEDDING_SCHEMA_VERSION) return null;
    if (record.contentHash !== contentHash || modelFingerprint(record.model) !== modelFingerprint(model)) return null;
    if (!isFiniteVector(record.vector) || record.vector.length !== record.dimension) return null;
    if (model.expectedDimension && record.dimension !== model.expectedDimension) return null;
    return record.vector;
  }

  async putEmbedding(model: VisualModelSpec, contentHash: string, vector: number[]): Promise<void> {
    if (!sha256.test(contentHash)) throw new Error("Embedding content hash must be a SHA-256 digest.");
    if (!isFiniteVector(vector)) throw new Error("Refusing to cache an empty or non-finite visual embedding.");
    if (model.expectedDimension && vector.length !== model.expectedDimension) {
      throw new Error(`Expected a ${model.expectedDimension}D embedding, received ${vector.length}D.`);
    }
    const record: CachedEmbeddingRecord = {
      schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
      model,
      contentHash,
      dimension: vector.length,
      vector,
      cachedAt: new Date().toISOString(),
    };
    await atomicWrite(this.embeddingPath(model, contentHash), `${JSON.stringify(record)}\n`);
  }

  private embeddingPath(model: VisualModelSpec, contentHash: string): string {
    return join(this.rootDir, "embeddings", modelFingerprint(model), `${contentHash}.json`);
  }
}
