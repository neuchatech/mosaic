import { resolve } from "node:path";
import type { Product } from "../src/domain/catalog";
import {
  DEFAULT_CLIP_MODEL,
  VisualEmbeddingCache,
  createTransformersClipEncoder,
  runVisualEmbeddingPipeline,
  type HybridVectorWeights,
  type VisualEmbeddingItem,
  type VisualEmbeddingProgress,
  type VisualEmbeddingRun,
  type VisualImageEncoder,
  type VisualModelSpec,
} from "../src/embeddings";
import { productFeatureVector } from "../src/projection/features";

export type CatalogVisualEmbeddingOptions = {
  cacheDir?: string;
  modelCacheDir?: string;
  model?: VisualModelSpec;
  allowModelDownload?: boolean;
  imagesPerItem?: number;
  force?: boolean;
  weights?: HybridVectorWeights;
  signal?: AbortSignal;
  onProgress?: (progress: VisualEmbeddingProgress) => void;
  onResult?: Parameters<typeof runVisualEmbeddingPipeline>[0]["onResult"];
  encoder?: VisualImageEncoder | null;
};

export function catalogVisualEmbeddingItems(products: Product[]): VisualEmbeddingItem[] {
  return products.map((product) => ({
    id: product.id,
    imageUrls: product.images,
    metadataVector: productFeatureVector(product),
    updatedAt: product.updatedAt,
  }));
}

export async function embedCatalogProducts(
  products: Product[],
  options: CatalogVisualEmbeddingOptions = {},
): Promise<VisualEmbeddingRun> {
  const cacheDir = resolve(options.cacheDir ?? "data/image-cache/visual-embeddings");
  const modelCacheDir = resolve(options.modelCacheDir ?? "data/image-cache/transformers");
  const requestedModel = options.model ?? options.encoder?.model ?? DEFAULT_CLIP_MODEL;
  let encoder = options.encoder ?? null;
  let ownsEncoder = false;
  let modelError: string | undefined;
  const emit = (progress: VisualEmbeddingProgress) => {
    try { options.onProgress?.(progress); } catch { /* Progress rendering is best effort. */ }
  };

  if (options.encoder === undefined) {
    emit({ phase: "model-loading", processed: 0, total: products.length, message: requestedModel.id });
    try {
      encoder = await createTransformersClipEncoder({
        model: requestedModel,
        modelCacheDir,
        allowModelDownload: options.allowModelDownload,
        onModelProgress: (progress) => emit({
          phase: "model-loading",
          processed: 0,
          total: products.length,
          modelFile: progress.file,
          modelProgress: progress.progress,
          message: progress.status,
        }),
      });
      ownsEncoder = true;
      emit({ phase: "model-ready", processed: 0, total: products.length, message: requestedModel.id });
    } catch (error) {
      modelError = `CLIP unavailable locally: ${error instanceof Error ? error.message : String(error)}`;
      emit({ phase: "model-unavailable", processed: 0, total: products.length, message: modelError });
    }
  } else if (!encoder) {
    modelError = "CLIP encoder disabled; metadata-only fallback active.";
    emit({ phase: "model-unavailable", processed: 0, total: products.length, message: modelError });
  }

  const model = encoder?.model ?? requestedModel;
  try {
    return await runVisualEmbeddingPipeline({
      items: catalogVisualEmbeddingItems(products),
      cache: new VisualEmbeddingCache({ rootDir: cacheDir }),
      model,
      encoder,
      modelError,
      imagesPerItem: options.imagesPerItem,
      force: options.force,
      weights: options.weights,
      signal: options.signal,
      onProgress: options.onProgress,
      onResult: options.onResult,
    });
  } finally {
    if (ownsEncoder) await encoder?.close?.();
  }
}
