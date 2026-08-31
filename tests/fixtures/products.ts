import type { Product } from "../../src/domain/catalog";

const timestamp = "2026-01-15T12:00:00.000Z";

export const seedProducts: Product[] = [
  ["fixture-a", "Sample jacket", 120, "Vestes", "Navy", "blue", "regular", ["outerwear", "sample"], 88, .08, .12],
  ["fixture-b", "Sample trousers", 80, "Pantalons", "Grey", "grey", "wide", ["bottom", "sample"], 87, .31, .22],
  ["fixture-c", "Sample knit", 95, "Mailles", "Cream", "beige", "relaxed", ["top", "sample"], 86, .54, .10],
  ["fixture-d", "Sample overshirt", 110, "Vestes", "Green", "green", "straight", ["layer", "sample"], 79, .75, .24],
  ["fixture-e", "Sample wool trousers", 140, "Pantalons", "Charcoal", "grey", "wide", ["wool", "sample"], 76, .18, .61],
  ["fixture-f", "Sample cardigan", 105, "Mailles", "Black", "black", "cropped", ["cardigan", "sample"], 74, .46, .58],
  ["fixture-g", "Sample denim", 100, "Pantalons", "Blue", "blue", "wide", ["denim", "sample"], 71, .70, .65],
  ["fixture-h", "Sample sweater", 90, "Mailles", "Red", "red", "relaxed", ["sweater", "sample"], 68, .85, .55],
].map((entry, index) => {
  const [brand, name, price, category, color, colorFamily, fit, tags, score, x, y] = entry as [string, string, number, string, string, string, string, string[], number, number, number];
  return {
    id: `fixture-${index + 1}`,
    kind: "shop",
    source: "test-fixture",
    sourceId: `fixture-${index + 1}`,
    url: `https://example.invalid/product/${index + 1}`,
    brand,
    name,
    description: "Deterministic product fixture for automated tests.",
    price,
    originalPrice: null,
    currency: "USD",
    category,
    color,
    colorFamily,
    fit,
    attributes: { fixture: true },
    materials: [],
    tags,
    sizes: ["S", "M", "L"],
    images: [],
    available: true,
    decision: "unseen",
    x,
    y,
    scores: { style_match: score, versatility: Math.max(60, score - 4) },
    importedAt: timestamp,
    updatedAt: timestamp,
  } satisfies Product;
});
