import { VisualEmbeddingCache } from "./cache";
import { buildHybridVector, meanNormalizedVectors, type HybridVectorWeights } from "./vector";
import {
  VISUAL_EMBEDDING_SCHEMA_VERSION,
  type VisualEmbeddingItem,
  type VisualEmbeddingProgress,
  type VisualEmbeddingResult,
  type VisualEmbeddingRun,
  type VisualImageEncoder,
  type VisualModelSpec,
} from "./types";

export type RunVisualEmbeddingPipelineOptions = {
  items: VisualEmbeddingItem[];
  cache: VisualEmbeddingCache;
  model: VisualModelSpec;
  encoder: VisualImageEncoder | null;
  modelError?: string;
  imagesPerItem?: number;
  force?: boolean;
  weights?: HybridVectorWeights;
  signal?: AbortSignal;
  now?: () => Date;
  onProgress?: (progress: VisualEmbeddingProgress) => void;
  onResult?: (result: VisualEmbeddingResult) => void | Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeVector(vector: number[]): number[] {
  return vector.map((value) => Number.isFinite(value) ? value : 0);
}

function uniqueSources(sources: string[], limit: number): string[] {
  return [...new Set(sources.map((source) => source.trim()).filter(Boolean))].slice(0, limit);
}

export async function runVisualEmbeddingPipeline(
  options: RunVisualEmbeddingPipelineOptions,
): Promise<VisualEmbeddingRun> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const results: VisualEmbeddingResult[] = [];
  const imagesPerItem = Math.min(5, Math.max(1, options.imagesPerItem ?? 1));
  const counters = {
    embedded: 0,
    metadataOnly: 0,
    cacheHits: 0,
    imageDownloads: 0,
    errors: 0,
  };
  const emit = (progress: Omit<VisualEmbeddingProgress, "processed" | "total">) => {
    try {
      options.onProgress?.({
        ...progress,
        processed: results.length,
        total: options.items.length,
      });
    } catch {
      // A progress renderer must never stop a long local indexing run.
    }
  };

  for (const item of options.items) {
    if (options.signal?.aborted) break;
    emit({ phase: "item-start", itemId: item.id });
    const metadataVector = sanitizeVector(item.metadataVector);
    const candidateSources = uniqueSources(item.imageUrls, imagesPerItem);
    const visualVectors: number[][] = [];
    const usedImageUrls: string[] = [];
    const contentHashes: string[] = [];
    const itemErrors: string[] = [];
    let everyEmbeddingWasCached = candidateSources.length > 0;

    try {
      for (const source of candidateSources) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("Embedding run cancelled.");
        try {
          const image = options.encoder
            ? await options.cache.getImage(source, { force: options.force, signal: options.signal })
            : await options.cache.getCachedImage(source);
          if (!image) {
            everyEmbeddingWasCached = false;
            continue;
          }
          if (image.cacheHit) {
            emit({ phase: "image-cache-hit", itemId: item.id, imageUrl: source });
          } else {
            counters.imageDownloads += 1;
            emit({ phase: "image-downloaded", itemId: item.id, imageUrl: source });
          }

          const cachedVector = options.force
            ? null
            : await options.cache.getEmbedding(options.model, image.contentHash);
          let vector = cachedVector;
          if (vector) {
            emit({ phase: "embedding-cache-hit", itemId: item.id, imageUrl: source });
          } else if (options.encoder) {
            everyEmbeddingWasCached = false;
            vector = sanitizeVector(await options.encoder.encodeImage(image.path));
            await options.cache.putEmbedding(options.model, image.contentHash, vector);
            emit({ phase: "image-embedded", itemId: item.id, imageUrl: source });
          } else {
            everyEmbeddingWasCached = false;
          }

          if (vector) {
            visualVectors.push(vector);
            usedImageUrls.push(source);
            contentHashes.push(image.contentHash);
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          itemErrors.push(`${source.slice(0, 120)}: ${errorMessage(error)}`);
          everyEmbeddingWasCached = false;
        }
      }

      const visualVector = visualVectors.length ? meanNormalizedVectors(visualVectors) : null;
      const mode = visualVector
        ? metadataVector.length ? "hybrid" : "visual-only"
        : "metadata-only";
      const fallbackError = !visualVector && options.modelError && candidateSources.length
        ? options.modelError
        : undefined;
      const result: VisualEmbeddingResult = {
        schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
        itemId: item.id,
        mode,
        model: options.model,
        visualVector,
        metadataVector,
        hybridVector: buildHybridVector(visualVector, metadataVector, options.weights),
        imageUrls: usedImageUrls,
        contentHashes,
        cacheHit: Boolean(visualVector && everyEmbeddingWasCached),
        ...((itemErrors.length || fallbackError) ? {
          error: [...itemErrors, fallbackError].filter(Boolean).join(" | "),
        } : {}),
        processedAt: (options.now?.() ?? new Date()).toISOString(),
      };
      results.push(result);
      if (visualVector) {
        counters.embedded += 1;
        if (result.cacheHit) counters.cacheHits += 1;
      } else {
        counters.metadataOnly += 1;
      }
      if (itemErrors.length) counters.errors += 1;
      await options.onResult?.(result);
      emit({
        phase: itemErrors.length ? "item-error" : "item-complete",
        itemId: item.id,
        message: result.error,
      });
    } catch (error) {
      if (options.signal?.aborted) break;
      counters.errors += 1;
      counters.metadataOnly += 1;
      const result: VisualEmbeddingResult = {
        schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
        itemId: item.id,
        mode: "metadata-only",
        model: options.model,
        visualVector: null,
        metadataVector,
        hybridVector: buildHybridVector(null, metadataVector, options.weights),
        imageUrls: [],
        contentHashes: [],
        cacheHit: false,
        error: errorMessage(error),
        processedAt: (options.now?.() ?? new Date()).toISOString(),
      };
      results.push(result);
      await options.onResult?.(result);
      emit({ phase: "item-error", itemId: item.id, message: result.error });
    }
  }

  const summary = {
    total: options.items.length,
    processed: results.length,
    ...counters,
    cancelled: Boolean(options.signal?.aborted),
    modelAvailable: Boolean(options.encoder),
    ...(options.modelError ? { modelError: options.modelError } : {}),
    startedAt,
    finishedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  emit({ phase: "complete", message: summary.cancelled ? "Embedding run cancelled." : "Embedding run complete." });
  return {
    schemaVersion: VISUAL_EMBEDDING_SCHEMA_VERSION,
    model: options.model,
    results,
    summary,
  };
}
