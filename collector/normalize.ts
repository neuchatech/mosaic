import { productSchema, type Product } from "../src/domain/catalog";
import { stableProductId } from "../src/domain/ids";
import type { RawProduct } from "./types";

function guessCategory(value: string): string {
  const normalized = value.toLocaleLowerCase();
  if (/pantalon|trouser|jean/.test(normalized)) return "Pantalons";
  if (/veste|jacket|blouson|surchemise|overshirt/.test(normalized)) return "Vestes";
  if (/pull|sweater|maille|knit|cardigan/.test(normalized)) return "Mailles";
  if (/chemise|shirt/.test(normalized)) return "Chemises";
  if (/t-shirt|tee/.test(normalized)) return "T-shirts";
  return "Autre";
}

export function normalizeProduct(source: string, raw: RawProduct): Product {
  const now = new Date().toISOString();
  const sourceId = raw.sourceId || new URL(raw.url).pathname;
  return productSchema.parse({
    id: stableProductId(source, sourceId),
    kind: "shop",
    source,
    sourceId,
    url: raw.url,
    brand: raw.brand ?? "Unknown",
    name: raw.name,
    description: raw.description ?? "",
    price: raw.price ?? null,
    originalPrice: raw.originalPrice ?? null,
    currency: raw.currency ?? "CHF",
    category: raw.category ?? guessCategory(`${raw.name} ${raw.description ?? ""}`),
    color: raw.color ?? "Inconnue",
    colorFamily: raw.colorFamily ?? "unknown",
    fit: raw.fit ?? "unknown",
    attributes: raw.attributes ?? {},
    materials: raw.materials ?? [],
    tags: raw.tags ?? [],
    sizes: raw.sizes ?? [],
    images: raw.images ?? [],
    available: raw.available ?? true,
    stockStatus: raw.stockStatus ?? "unknown",
    stockCheckedAt: raw.stockCheckedAt ?? null,
    priceCheckedAt: raw.priceCheckedAt ?? null,
    sizesCheckedAt: raw.sizesCheckedAt ?? null,
    decision: "unseen",
    x: .5,
    y: .5,
    scores: {},
    importedAt: now,
    updatedAt: now,
  });
}
