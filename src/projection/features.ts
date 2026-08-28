import type { Product } from "../domain/catalog";

const dimensions = {
  categories: ["vestes", "pantalons", "mailles", "chemises", "t-shirts", "chaussures"],
  colors: ["brown", "beige", "green", "blue", "grey", "black", "white"],
  fits: ["cropped", "wide", "relaxed", "straight", "slim", "oversized"],
  tags: ["tailored", "textured", "washed", "layering", "minimal", "utility", "timeless", "casual"],
};

function oneHot(value: string, vocabulary: string[]): number[] {
  const normalized = value.toLocaleLowerCase();
  return vocabulary.map((entry) => normalized.includes(entry) ? 1 : 0);
}

function multiHot(values: string[], vocabulary: string[]): number[] {
  const normalized = values.map((value) => value.toLocaleLowerCase());
  return vocabulary.map((entry) => normalized.some((value) => value.includes(entry)) ? 1 : 0);
}

export function productFeatureVector(product: Product): number[] {
  return [
    ...oneHot(product.category, dimensions.categories),
    ...oneHot(product.colorFamily, dimensions.colors),
    ...oneHot(product.fit, dimensions.fits),
    ...multiHot(product.tags, dimensions.tags),
    Math.min((product.price ?? 0) / 500, 1),
    (product.scores.style_match ?? 50) / 100,
    (product.scores.versatility ?? 50) / 100,
  ];
}
