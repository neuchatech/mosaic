import type { Product } from "../src/domain/catalog";

export type OutfitRole = "anchor" | "outer" | "top" | "bottom" | "shoes" | "accessory";

export type GeneratedOutfit = {
  title: string;
  anchorProductId: string;
  items: { productId: string; role: OutfitRole; reason: string }[];
  compatibilityScore: number;
  noveltyScore: number;
  missingRoles: OutfitRole[];
};

const neutralColors = new Set(["black", "white", "grey", "gray", "beige", "brown", "neutral", "unknown"]);

export function outfitRole(product: Product): OutfitRole {
  const text = `${product.category} ${product.name}`.toLocaleLowerCase("fr-CH");
  if (/chauss|shoe|sneaker|boot|loafer|derby|mocassin/.test(text)) return "shoes";
  if (/pantalon|trouser|jean|short|jupe|skirt/.test(text)) return "bottom";
  if (/veste|jacket|blouson|manteau|coat|surchemise|overshirt/.test(text)) return "outer";
  if (/sac|bag|ceinture|belt|bonnet|hat|casquette|cap|écharpe|scarf/.test(text)) return "accessory";
  return "top";
}

function compatibility(anchor: Product, candidate: Product): number {
  let score = candidate.kind === "owned" || candidate.decision === "owned" ? 58 : 42;
  const anchorColor = anchor.colorFamily.toLocaleLowerCase();
  const candidateColor = candidate.colorFamily.toLocaleLowerCase();
  if (anchorColor === candidateColor) score += 14;
  else if (neutralColors.has(anchorColor) || neutralColors.has(candidateColor)) score += 11;
  const anchorTags = new Set(anchor.tags.map((tag) => tag.toLocaleLowerCase()));
  score += Math.min(18, candidate.tags.filter((tag) => anchorTags.has(tag.toLocaleLowerCase())).length * 6);
  if (outfitRole(anchor) !== outfitRole(candidate)) score += 8;
  if (candidate.decision === "saved") score += 3;
  return Math.min(100, score);
}

function novelty(anchor: Product, products: Product[]): number {
  const comparable = products.filter((product) =>
    product.id !== anchor.id
    && (product.kind === "owned" || product.decision === "owned")
    && outfitRole(product) === outfitRole(anchor));
  if (comparable.length === 0) return 100;
  const closest = Math.max(...comparable.map((product) => compatibility(anchor, product)));
  return Math.max(0, Math.min(100, 115 - closest));
}

function neededRoles(anchorRole: OutfitRole): OutfitRole[] {
  if (anchorRole === "bottom") return ["top", "outer", "shoes"];
  if (anchorRole === "top") return ["bottom", "outer", "shoes"];
  if (anchorRole === "outer") return ["top", "bottom", "shoes"];
  if (anchorRole === "shoes") return ["top", "bottom", "outer"];
  return ["top", "bottom", "outer", "shoes"];
}

export function generateOutfits(anchor: Product, catalog: Product[], maxOutfits = 3): GeneratedOutfit[] {
  const candidates = catalog.filter((product) =>
    product.id !== anchor.id
    && product.kind !== "reference"
    && product.decision !== "rejected"
    && (product.kind === "owned" || product.decision === "owned" || product.decision === "saved"));
  const roles = neededRoles(outfitRole(anchor));
  const ranked = new Map(roles.map((role) => [
    role,
    candidates
      .filter((product) => outfitRole(product) === role)
      .sort((left, right) => compatibility(anchor, right) - compatibility(anchor, left) || left.id.localeCompare(right.id)),
  ]));
  const count = Math.max(1, Math.min(maxOutfits, 3));
  return Array.from({ length: count }, (_, variation) => {
    const chosen = roles.flatMap((role) => {
      const options = ranked.get(role) ?? [];
      const product = options[variation % Math.max(options.length, 1)];
      if (!product) return [];
      const owned = product.kind === "owned" || product.decision === "owned";
      return [{
        productId: product.id,
        role,
        reason: `${owned ? "Déjà dans le dressing" : "Pièce gardée"} · compatibilité ${compatibility(anchor, product)}/100`,
      }];
    });
    const missingRoles = roles.filter((role) => !chosen.some((item) => item.role === role));
    const scores = chosen.map((item) => compatibility(anchor, catalog.find((product) => product.id === item.productId)!));
    const compatibilityScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
    return {
      title: `${anchor.name} · tenue ${variation + 1}`,
      anchorProductId: anchor.id,
      items: [{ productId: anchor.id, role: "anchor" as const, reason: "Pièce de départ" }, ...chosen],
      compatibilityScore,
      noveltyScore: novelty(anchor, catalog),
      missingRoles,
    };
  });
}
