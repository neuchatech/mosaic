import type { Product } from "../domain/catalog";

const now = "2026-08-28T12:00:00.000Z";

export const seedProducts: Product[] = [
  ["selected", "Veste worker raccourcie", 129, "Vestes", "Tabac", "brown", "cropped", ["worker", "textured", "layering"], 94, .08, .12],
  ["weekday", "Pantalon ample à pinces", 79, "Pantalons", "Brun", "brown", "wide", ["pleated", "fluid", "tailored"], 91, .31, .22],
  ["massimo-dutti", "Maille texturée", 99, "Mailles", "Grège", "beige", "relaxed", ["textured", "quiet", "layering"], 88, .54, .10],
  ["carhartt-wip", "Surchemise vieillie", 149, "Vestes", "Olive", "green", "straight", ["washed", "utility", "layering"], 86, .75, .24],
  ["arket", "Pantalon laine ample", 139, "Pantalons", "Anthracite", "grey", "wide", ["tailored", "wool", "timeless"], 84, .18, .61],
  ["cos", "Cardigan compact", 115, "Mailles", "Chocolat", "brown", "cropped", ["compact", "layering", "minimal"], 82, .46, .58],
  ["levis", "Jean 568 loose", 109, "Pantalons", "Bleu vieilli", "blue", "wide", ["washed", "denim", "casual"], 79, .70, .65],
  ["minimum", "Pull col rond dense", 89, "Mailles", "Camel", "brown", "relaxed", ["textured", "warm", "quiet"], 77, .85, .55],
].map((item, index) => {
  const [brand, name, price, category, color, colorFamily, fit, tags, score, x, y] = item as [string, string, number, string, string, string, string, string[], number, number, number];
  return {
    id: `seed_${index + 1}`,
    kind: "shop",
    source: "seed",
    sourceId: `seed-${index + 1}`,
    url: `https://example.invalid/product/${index + 1}`,
    brand,
    name,
    description: "Produit de démonstration inspiré du board de référence.",
    price,
    originalPrice: null,
    currency: "CHF",
    category,
    color,
    colorFamily,
    fit,
    attributes: { season: "autumn-winter", style: "earth-tones" },
    materials: [],
    tags,
    sizes: ["S", "M", "L"],
    images: ["/seed/reference-board.png"],
    available: true,
    decision: index < 3 ? "saved" : "unseen",
    x,
    y,
    scores: { style_match: score, versatility: Math.max(60, score - 4) },
    importedAt: now,
    updatedAt: now,
  } satisfies Product;
});
