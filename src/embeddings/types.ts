export const VISUAL_EMBEDDING_SCHEMA_VERSION = 1 as const;

export type ClipDType = "q8" | "int8" | "uint8" | "q4" | "q4f16" | "fp16" | "fp32";

export type VisualModelSpec = {
  id: string;
  revision: string;
  dtype: ClipDType;
  expectedDimension?: number;
};

export type VisualEmbeddingItemKind = "shop" | "reference" | "owned";

export type VisualEmbeddingItem = {
  id: string;
  kind?: VisualEmbeddingItemKind;
  imageUrls: string[];
  metadataVector: number[];
  updatedAt?: string;
};

export type VisualEmbeddingMode = "hybrid" | "visual-only" | "metadata-only";

export type VisualEmbeddingResult = {
  schemaVersion: typeof VISUAL_EMBEDDING_SCHEMA_VERSION;
  itemId: string;
  mode: VisualEmbeddingMode;
  model: VisualModelSpec;
  visualVector: number[] | null;
  metadataVector: number[];
  hybridVector: number[];
  imageUrls: string[];
  contentHashes: string[];
  cacheHit: boolean;
  error?: string;
  processedAt: string;
};

export type VisualEmbeddingSummary = {
  total: number;
  processed: number;
  embedded: number;
  metadataOnly: number;
  cacheHits: number;
  imageDownloads: number;
  errors: number;
  cancelled: boolean;
  modelAvailable: boolean;
  modelError?: string;
  startedAt: string;
  finishedAt: string;
};

export type VisualEmbeddingRun = {
  schemaVersion: typeof VISUAL_EMBEDDING_SCHEMA_VERSION;
  model: VisualModelSpec;
  results: VisualEmbeddingResult[];
  summary: VisualEmbeddingSummary;
};

export type VisualEmbeddingProgressPhase =
  | "model-loading"
  | "model-ready"
  | "model-unavailable"
  | "item-start"
  | "image-cache-hit"
  | "image-downloaded"
  | "embedding-cache-hit"
  | "image-embedded"
  | "item-complete"
  | "item-error"
  | "complete";

export type VisualEmbeddingProgress = {
  phase: VisualEmbeddingProgressPhase;
  processed: number;
  total: number;
  itemId?: string;
  imageUrl?: string;
  message?: string;
  modelFile?: string;
  modelProgress?: number;
};

export type ModelLoadProgress = {
  file?: string;
  progress?: number;
  status?: string;
};

export interface VisualImageEncoder {
  readonly model: VisualModelSpec;
  encodeImage(imagePath: string): Promise<number[]>;
  close?(): Promise<void>;
}
