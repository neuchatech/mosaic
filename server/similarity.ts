import { resolve } from "node:path";
import type { Product } from "../src/domain/catalog";
import { readVisualEmbeddingArtifact, hybridVectorsByItem } from "../src/embeddings";
import { filterVisualCandidates, type VisualConstraintsInput } from "./visual-constraints";
import type { CatalogRepository } from "./repository";

const artifactPath = resolve("data/image-cache/visual-embeddings.json");

function normalizedMean(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dimension = vectors[0]?.length ?? 0;
  if (!dimension || vectors.some((vector) => vector.length !== dimension)) return null;
  const mean = new Array<number>(dimension).fill(0);
  for (const vector of vectors) vector.forEach((value, index) => { mean[index] += value; });
  const norm = Math.hypot(...mean);
  return norm > 0 ? mean.map((value) => value / norm) : null;
}

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null;
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

export type VisualRetrievalRankingMode =
  | "clip-image"
  | "clip-anchor"
  | "hybrid-anchor"
  | "pca-coordinate"
  | "catalog-order";

export type RankedSimilarityProduct = {
  product: Product;
  /** Comparable within one retrieval response, normalized to the 0..1 range. */
  score: number;
  mode: VisualRetrievalRankingMode;
  /** One normalized cosine score per compatible reference vector. */
  referenceScores: number[];
};

function normalizedCosineScore(left: number[], right: number[]): number | null {
  const similarity = cosineSimilarity(left, right);
  return similarity === null ? null : Math.min(1, Math.max(0, (similarity + 1) / 2));
}

function coordinateSimilarity(product: Product, anchors: Product[]): number | null {
  if (!anchors.length) return null;
  const distance = Math.min(...anchors.map((anchor) => Math.hypot(product.x - anchor.x, product.y - anchor.y)));
  return Math.max(0, 1 - distance / Math.SQRT2);
}

/**
 * Rank an already scoped candidate universe against compatible reference vectors.
 * Items missing the primary vector signal are retained behind explicitly labelled
 * PCA/catalog fallbacks instead of being silently discarded.
 */
export function rankProductsByReferenceVectors(input: {
  candidates: Product[];
  candidateVectors: Map<string, number[]>;
  referenceVectors: number[][];
  anchors?: Product[];
  vectorMode: Extract<VisualRetrievalRankingMode, "clip-image" | "clip-anchor" | "hybrid-anchor">;
  limit: number;
}): RankedSimilarityProduct[] {
  const anchors = input.anchors ?? [];
  const requestedLimit = Number.isFinite(input.limit) ? Math.trunc(input.limit) : 30;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const references = input.referenceVectors.filter((vector) => vector.length > 0 && vector.every(Number.isFinite));
  const scored = input.candidates.map((product, index) => {
    const vector = input.candidateVectors.get(product.id);
    const referenceScores = vector
      ? references.flatMap((reference) => {
          const score = normalizedCosineScore(reference, vector);
          return score === null ? [] : [score];
        })
      : [];
    if (referenceScores.length) {
      return {
        product,
        score: Math.max(...referenceScores),
        mode: input.vectorMode as VisualRetrievalRankingMode,
        referenceScores,
        index,
        tier: 0,
      };
    }
    const fallbackScore = coordinateSimilarity(product, anchors);
    if (fallbackScore !== null) {
      return {
        product,
        score: fallbackScore,
        mode: "pca-coordinate" as const,
        referenceScores: [],
        index,
        tier: 1,
      };
    }
    return {
      product,
      score: 0,
      mode: "catalog-order" as const,
      referenceScores: [],
      index,
      tier: 2,
    };
  });
  return scored
    .sort((left, right) => left.tier - right.tier || right.score - left.score || left.index - right.index
      || left.product.id.localeCompare(right.product.id))
    .slice(0, limit)
    .map((entry) => ({
      product: entry.product,
      score: entry.score,
      mode: entry.mode,
      referenceScores: entry.referenceScores,
    }));
}

export type SimilarProductsInput = {
  productIds: string[];
  limit?: number;
  constraints?: VisualConstraintsInput;
  /** Optional pre-filtered universe used by generic research. */
  candidateIds?: string[];
};

export async function findSimilarProducts(input: SimilarProductsInput, repository: CatalogRepository): Promise<Product[]> {
  const anchorIds = [...new Set(input.productIds)].slice(0, 12);
  if (!anchorIds.length) return [];
  const artifact = await readVisualEmbeddingArtifact(artifactPath);
  const vectors = artifact ? hybridVectorsByItem(artifact) : new Map<string, number[]>();
  const anchorVector = normalizedMean(anchorIds.flatMap((id) => {
    const vector = vectors.get(id);
    return vector ? [vector] : [];
  }));
  const workspaceId = input.constraints?.workspaceId;
  const anchors = anchorIds.map((id) => repository.getProduct(id, workspaceId)).filter(Boolean) as Product[];
  if (!anchors.length) return [];
  const candidates = (input.candidateIds
    ? [...new Set(input.candidateIds)]
      .map((id) => repository.getProduct(id, workspaceId))
      .filter(Boolean) as Product[]
    : filterVisualCandidates(repository.listProducts({ workspaceId, limit: 10_000 }), {
      includeSaved: false,
      includeRejected: false,
      ...(input.constraints ?? {}),
    }))
    .filter((product) => !anchorIds.includes(product.id));
  const scored = candidates.map((product) => {
    const vector = vectors.get(product.id);
    const visualScore = anchorVector && vector ? cosineSimilarity(anchorVector, vector) : null;
    const coordinateScore = Math.max(0, 1 - Math.min(...anchors.map((anchor) => Math.hypot(product.x - anchor.x, product.y - anchor.y))) / Math.SQRT2);
    const similarity = visualScore === null ? coordinateScore : visualScore;
    return {
      product: {
        ...product,
        scores: { ...product.scores, similarity: Math.round(Math.max(0, similarity) * 100) },
        attributes: {
          ...product.attributes,
          selectionReason: visualScore === null
            ? "Proche dans la projection locale; CLIP sera utilisé après indexation de cette image."
            : `Proximité visuelle CLIP avec ${anchors.length > 1 ? `${anchors.length} références` : anchors[0]!.name}.`,
        },
      },
      similarity,
    };
  });
  return scored
    .sort((left, right) => right.similarity - left.similarity
      || (left.product.price ?? Number.POSITIVE_INFINITY) - (right.product.price ?? Number.POSITIVE_INFINITY))
    .slice(0, Math.min(100, Math.max(1, input.limit ?? 30)))
    .map((entry) => entry.product);
}
