import { createHash } from "node:crypto";
import type { Product } from "../src/domain/catalog";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";

const maxEntries = 32;
const cache = new Map<string, Map<string, { x: number; y: number }>>();

function signature(products: Product[]): string {
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
  return createHash("sha256").update(JSON.stringify(features)).digest("hex");
}

export function projectCompactCached(products: Product[]): Product[] {
  const key = signature(products);
  let coordinates = cache.get(key);
  if (!coordinates) {
    coordinates = new Map(compactProjection(projectProducts(products)).map((product) => [
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
