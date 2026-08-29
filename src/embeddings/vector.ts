export type HybridVectorWeights = {
  visual: number;
  metadata: number;
};

export const DEFAULT_HYBRID_WEIGHTS: HybridVectorWeights = {
  visual: 0.68,
  metadata: 0.32,
};

function finiteVector(vector: ArrayLike<number>): number[] {
  return Array.from(vector, (value) => Number.isFinite(value) ? Number(value) : 0);
}

export function l2Normalize(vector: ArrayLike<number>): number[] {
  const values = finiteVector(vector);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map((value) => value / norm) : values;
}

export function meanNormalizedVectors(vectors: ArrayLike<number>[]): number[] {
  if (vectors.length === 0) return [];
  const dimension = vectors[0]?.length ?? 0;
  if (!vectors.every((vector) => vector.length === dimension)) {
    throw new Error("Cannot average visual embeddings with different dimensions.");
  }
  const mean = Array.from({ length: dimension }, () => 0);
  for (const vector of vectors) {
    const normalized = l2Normalize(vector);
    normalized.forEach((value, index) => { mean[index] += value / vectors.length; });
  }
  return l2Normalize(mean);
}

/**
 * Concatenate two L2-normalized blocks. The square-root scales make squared
 * Euclidean distance equivalent to a weighted sum of visual and metadata
 * cosine distances. Downstream PCA should use `scale: false`; per-column
 * standardization would erase these block weights.
 */
export function buildHybridVector(
  visualVector: ArrayLike<number> | null,
  metadataVector: ArrayLike<number>,
  weights: HybridVectorWeights = DEFAULT_HYBRID_WEIGHTS,
): number[] {
  const hasVisual = Boolean(visualVector && visualVector.length > 0);
  const hasMetadata = metadataVector.length > 0;
  const visualWeight = hasVisual ? Math.max(0, weights.visual) : 0;
  const metadataWeight = hasMetadata ? Math.max(0, weights.metadata) : 0;
  const total = visualWeight + metadataWeight;
  if (total === 0) return [];

  const metadata = l2Normalize(metadataVector);
  if (!hasVisual || !visualVector) return metadata;

  const visualScale = Math.sqrt(visualWeight / total);
  const metadataScale = Math.sqrt(metadataWeight / total);
  return [
    ...l2Normalize(visualVector).map((value) => value * visualScale),
    ...metadata.map((value) => value * metadataScale),
  ];
}
