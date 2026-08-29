import { z } from "zod";
import type { Product } from "../src/domain/catalog";

export const visualConstraintsSchema = z.object({
  size: z.string().trim().min(1).optional(),
  sizes: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  minPrice: z.number().nonnegative().optional(),
  maxPrice: z.number().nonnegative().optional(),
  sources: z.array(z.string().min(1)).max(20).optional(),
  categories: z.array(z.string().min(1)).max(20).optional(),
  freshWithinHours: z.number().positive().max(24 * 365).optional(),
  includeRejected: z.boolean().default(false),
  includeSaved: z.boolean().default(false),
});

export type VisualConstraints = z.infer<typeof visualConstraintsSchema>;
export type VisualConstraintsInput = z.input<typeof visualConstraintsSchema>;

function canonical(value: string): string {
  return value.trim().toLocaleUpperCase("fr-CH").replace(/^TAILLE\s+/i, "");
}

function withinHours(value: string | null | undefined, hours: number, now: number): boolean {
  if (!value) return false;
  const capturedAt = Date.parse(value);
  return Number.isFinite(capturedAt) && now - capturedAt <= hours * 60 * 60 * 1000;
}

export function matchesVisualConstraints(
  product: Product,
  input: VisualConstraintsInput,
  now = Date.now(),
): boolean {
  const constraints = visualConstraintsSchema.parse(input);
  if (product.kind !== "shop") return false;
  if (!constraints.includeRejected && product.decision === "rejected") return false;
  if (product.decision === "owned") return false;
  if (!constraints.includeSaved && product.decision === "saved") return false;
  if (constraints.sources?.length && !constraints.sources.includes(product.source)) return false;
  if (constraints.categories?.length && !constraints.categories.includes(product.category)) return false;
  if (constraints.minPrice !== undefined && (product.price === null || product.price < constraints.minPrice)) return false;
  if (constraints.maxPrice !== undefined && (product.price === null || product.price > constraints.maxPrice)) return false;

  const requestedSizes = [...new Set([
    ...(constraints.size ? [constraints.size] : []),
    ...(constraints.sizes ?? []),
  ].map(canonical))];
  if (requestedSizes.length) {
    const freshWithinHours = constraints.freshWithinHours ?? 24 * 7;
    if (product.stockStatus !== "in_stock" || !product.available) return false;
    if (product.attributes.sizeAvailabilityKnown !== true) return false;
    if (!withinHours(product.sizesCheckedAt, freshWithinHours, now)) return false;
    if (!product.sizes.some((size) => requestedSizes.includes(canonical(size)))) return false;
  } else if (constraints.freshWithinHours !== undefined) {
    if (!withinHours(product.stockCheckedAt, constraints.freshWithinHours, now)) return false;
  }
  return true;
}

export function filterVisualCandidates(
  products: Product[],
  constraints: VisualConstraintsInput,
  now = Date.now(),
): Product[] {
  return products.filter((product) => matchesVisualConstraints(product, constraints, now));
}
