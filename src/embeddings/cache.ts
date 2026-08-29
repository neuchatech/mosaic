import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VISUAL_EMBEDDING_SCHEMA_VERSION,
  type VisualModelSpec,
} from "./types";

const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;

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

export type ImageSourceLoader = (
  source: string,
  options: { signal?: AbortSignal; maxBytes: number },
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

function decodeDataUrl(source: string): ImageLoadResult {
  const match = source.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) throw new Error("Invalid data image URL.");
  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return { bytes, ...(match[1] ? { contentType: match[1] } : {}) };
}

export const defaultImageSourceLoader: ImageSourceLoader = async (source, options) => {
  let result: ImageLoadResult;
  if (source.startsWith("data:")) {
    result = decodeDataUrl(source);
  } else {
    const url = new URL(source);
    if (url.protocol === "file:") {
      const path = fileURLToPath(url);
      const fileStat = await stat(path);
      if (fileStat.size > options.maxBytes) throw new Error(`Image exceeds ${options.maxBytes} bytes.`);
      result = { bytes: await readFile(path) };
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      const timeout = AbortSignal.timeout(20_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetch(url, {
        redirect: "follow",
        signal,
        headers: {
          accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
          "user-agent": "WardrobeAtlas/0.1 local-visual-index",
        },
      });
      if (!response.ok) throw new Error(`Image download failed (${response.status} ${response.statusText}).`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        throw new Error(`Image exceeds ${options.maxBytes} bytes.`);
      }
      result = {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type")?.split(";")[0] || undefined,
      };
    } else {
      throw new Error(`Unsupported image protocol: ${url.protocol}`);
    }
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
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  async getImage(
    source: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<CachedImage> {
    const sourceHash = hash(source);
    if (!options.force) {
      const cached = await this.getCachedImage(source);
      if (cached) return cached;
    }

    const loaded = await this.imageLoader(source, {
      signal: options.signal,
      maxBytes: this.maxImageBytes,
    });
    const contentHash = hash(loaded.bytes);
    const fileName = `${contentHash}.img`;
    const imagePath = join(this.rootDir, "images", fileName);
    try {
      const imageStat = await stat(imagePath);
      if (!imageStat.isFile() || imageStat.size !== loaded.bytes.byteLength) {
        await atomicWrite(imagePath, loaded.bytes);
      }
    } catch {
      await atomicWrite(imagePath, loaded.bytes);
    }
    const record: CachedImageRecord = {
      schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
      sourceHash,
      sourceLabel: sourceLabel(source),
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

  async getCachedImage(source: string): Promise<CachedImage | null> {
    const sourceHash = hash(source);
    const recordPath = join(this.rootDir, "sources", `${sourceHash}.json`);
    const record = await readJson<CachedImageRecord>(recordPath);
    if (record?.schemaVersion !== VISUAL_EMBEDDING_SCHEMA_VERSION || record.sourceHash !== sourceHash) return null;
    const imagePath = join(this.rootDir, "images", record.fileName);
    try {
      const imageStat = await stat(imagePath);
      if (!imageStat.isFile() || imageStat.size !== record.byteLength) return null;
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
    const path = this.embeddingPath(model, contentHash);
    const record = await readJson<CachedEmbeddingRecord>(path);
    if (!record || record.schemaVersion !== VISUAL_EMBEDDING_SCHEMA_VERSION) return null;
    if (record.contentHash !== contentHash || modelFingerprint(record.model) !== modelFingerprint(model)) return null;
    if (!isFiniteVector(record.vector) || record.vector.length !== record.dimension) return null;
    if (model.expectedDimension && record.dimension !== model.expectedDimension) return null;
    return record.vector;
  }

  async putEmbedding(model: VisualModelSpec, contentHash: string, vector: number[]): Promise<void> {
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
