import { PCA } from "ml-pca";
import type { Product } from "../domain/catalog";
import { productFeatureVector } from "./features";

function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => .5);
  return values.map((value) => (value - min) / (max - min));
}

export function projectProducts(products: Product[]): Product[] {
  if (products.length < 3) return products;
  const vectors = products.map(productFeatureVector);
  const varyingDimensions = vectors[0]
    .map((_, dimension) => dimension)
    .filter((dimension) => vectors.some((vector) => Math.abs(vector[dimension] - vectors[0][dimension]) > 1e-12));

  if (varyingDimensions.length === 0) {
    return products.map((product) => ({ ...product, x: .5, y: .5 }));
  }

  const usableVectors = vectors.map((vector) => varyingDimensions.map((dimension) => vector[dimension]));
  if (varyingDimensions.length === 1) {
    const xs = normalize(usableVectors.map((vector) => vector[0]));
    return products.map((product, index) => ({ ...product, x: .05 + xs[index] * .88, y: .5 }));
  }

  const pca = new PCA(usableVectors, { center: true, scale: true });
  const points = pca.predict(usableVectors, { nComponents: 2 }).to2DArray();
  const xs = normalize(points.map((point) => point[0]));
  const ys = normalize(points.map((point) => point[1]));

  return products.map((product, index) => ({
    ...product,
    x: .05 + xs[index] * .88,
    y: .05 + ys[index] * .82,
  }));
}
