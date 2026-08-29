import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Product } from "../src/domain/catalog";
import type { VisualEmbeddingRun } from "../src/embeddings";
import { compactProjection } from "../src/projection/compact";
import { projectProductsWithVectors } from "../src/projection/pca";

const maxEntries = 32;
const cache = new Map<string, Map<string, { x: number; y: number }>>();
const artifactPath = resolve("data/image-cache/visual-embeddings.json");
let artifactMtime = -1;
let artifactVectors: Map<string, number[]> | undefined;

function loadHybridVectors(): { revision: number; vectors?: Map<string, number[]> } {
  try {
    const mtime = statSync(artifactPath).mtimeMs;
    if (mtime !== artifactMtime) {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as VisualEmbeddingRun;
      artifactVectors = new Map(artifact.results
        .filter((result) => Array.isArray(result.hybridVector) && result.hybridVector.length > 0)
        .map((result) => [result.itemId, result.hybridVector]));
      artifactMtime = mtime;
      cache.clear();
    }
    return { revision: mtime, vectors: artifactVectors };
  } catch {
    artifactMtime = -1;
    artifactVectors = undefined;
    return { revision: -1 };
  }
}

function signature(products: Product[], embeddingRevision: number): string {
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
  return createHash("sha256").update(JSON.stringify([embeddingRevision, features])).digest("hex");
}

export function projectCompactCached(products: Product[]): Product[] {
  const hybrid = loadHybridVectors();
  const key = signature(products, hybrid.revision);
  let coordinates = cache.get(key);
  if (!coordinates) {
    coordinates = new Map(compactProjection(projectProductsWithVectors(products, {
      vectorsById: hybrid.vectors,
      scale: hybrid.vectors ? false : true,
    })).map((product) => [
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
