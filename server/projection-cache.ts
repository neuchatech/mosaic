import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Product } from "../src/domain/catalog";
import type { VisualEmbeddingRun } from "../src/embeddings";
import { projectProductsWithVectors } from "../src/projection/pca";

export type ProjectionMode = "hybrid" | "visual" | "metadata";

const maxEntries = 32;
const cache = new Map<string, Map<string, { x: number; y: number }>>();
const artifactPath = resolve("data/image-cache/visual-embeddings.json");
let artifactMtime = -1;
let artifactVectors: Record<ProjectionMode, Map<string, number[]>> | undefined;

function loadProjectionVectors(mode: ProjectionMode): { revision: number; vectors?: Map<string, number[]> } {
  try {
    const mtime = statSync(artifactPath).mtimeMs;
    if (mtime !== artifactMtime) {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as VisualEmbeddingRun;
      artifactVectors = {
        hybrid: new Map(artifact.results
          .filter((result) => Array.isArray(result.hybridVector) && result.hybridVector.length > 0)
          .map((result) => [result.itemId, result.hybridVector])),
        visual: new Map(artifact.results
          .filter((result) => Array.isArray(result.visualVector) && result.visualVector.length > 0)
          .map((result) => [result.itemId, result.visualVector!])),
        metadata: new Map(artifact.results
          .filter((result) => Array.isArray(result.metadataVector) && result.metadataVector.length > 0)
          .map((result) => [result.itemId, result.metadataVector])),
      };
      artifactMtime = mtime;
      cache.clear();
    }
    return { revision: mtime, vectors: artifactVectors?.[mode] };
  } catch {
    if (artifactMtime !== -1 || artifactVectors) cache.clear();
    artifactMtime = -1;
    artifactVectors = undefined;
    return { revision: -1 };
  }
}

function signature(products: Product[], embeddingRevision: number, mode: ProjectionMode): string {
  const features = products.map((product) => [
    product.id,
    product.category,
    product.colorFamily,
    product.fit,
    product.tags,
    product.price,
    product.scores.style_match,
    product.scores.versatility,
  ]);
  return createHash("sha256").update(JSON.stringify([mode, embeddingRevision, features])).digest("hex");
}

export function projectCompactCached(products: Product[], mode: ProjectionMode = "hybrid"): Product[] {
  const embedding = loadProjectionVectors(mode);
  // Metadata mode always reflects the current catalog fields. The embedding
  // artifact can legitimately predate a price, tag, or attribute refresh.
  const vectors = mode !== "metadata" && embedding.vectors && embedding.vectors.size > 0
    ? embedding.vectors
    : undefined;
  const key = signature(products, embedding.revision, mode);
  let coordinates = cache.get(key);
  if (!coordinates) {
    coordinates = new Map(projectProductsWithVectors(products, {
      vectorsById: vectors,
      scale: mode === "metadata" || !vectors,
      missingVector: mode === "visual" ? "zero" : "metadata",
    }).map((product) => [
      product.id,
      { x: product.x, y: product.y },
    ]));
    cache.set(key, coordinates);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(key);
    cache.set(key, coordinates);
  }
  return products.map((product) => ({ ...product, ...(coordinates?.get(product.id) ?? {}) }));
}

export function clearProjectionCache(): void {
  cache.clear();
}
