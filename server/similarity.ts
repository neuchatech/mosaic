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

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export type SimilarProductsInput = {
  productIds: string[];
  limit?: number;
  constraints?: VisualConstraintsInput;
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
  const anchors = anchorIds.map((id) => repository.getProduct(id)).filter(Boolean) as Product[];
  if (!anchors.length) return [];
  const candidates = filterVisualCandidates(repository.listProducts({ limit: 10_000 }), {
    includeSaved: false,
    includeRejected: false,
    ...(input.constraints ?? {}),
  }).filter((product) => !anchorIds.includes(product.id));
  const scored = candidates.map((product) => {
    const vector = vectors.get(product.id);
    const visualScore = anchorVector && vector ? cosine(anchorVector, vector) : null;
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
