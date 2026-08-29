import { jsonLdValuesFromHtml, visitJson } from "../html";
import type { RawProduct, ShopAdapter } from "../types";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record).filter((item): item is JsonRecord => Boolean(item));
  const item = record(value);
  return item ? [item] : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && String(value).trim() && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

function stock(value: unknown): "in_stock" | "out_of_stock" | "unknown" {
  const normalized = String(value ?? "").toLocaleLowerCase();
  if (normalized.includes("instock") || normalized.includes("limitedavailability") || normalized.includes("preorder")) {
    return "in_stock";
  }
  return normalized.includes("outofstock") ? "out_of_stock" : "unknown";
}

function returnPolicy(product: JsonRecord, offers: JsonRecord[]): RawProduct["attributes"] {
  const policy = records(offers[0]?.hasMerchantReturnPolicy ?? product.hasMerchantReturnPolicy)[0];
  if (!policy) return {};
  const days = number(policy.merchantReturnDays);
  const category = String(policy.returnPolicyCategory ?? "").toLocaleLowerCase();
  return {
    returnsLabel: category.includes("notpermitted")
      ? "Retours non acceptés"
      : days !== null ? `${days} jours` : "Politique de retour disponible",
    ...(days !== null ? { returnsWindowDays: days } : {}),
  };
}

export function extractGenericJsonLdProduct(
  html: string,
  pageUrl: string,
  observedAt = new Date().toISOString(),
): RawProduct | null {
  const groups: JsonRecord[] = [];
  const products: JsonRecord[] = [];
  for (const value of jsonLdValuesFromHtml(html)) {
    visitJson(value, (candidate) => {
      if (candidate["@type"] === "ProductGroup") groups.push(candidate);
      else if (candidate["@type"] === "Product") products.push(candidate);
    });
  }
  const product = groups[0] ?? products[0];
  if (!product) return null;
  const variants = product["@type"] === "ProductGroup" ? records(product.hasVariant) : [product];
  const observations = variants.map((variant) => {
    const offers = records(variant.offers);
    const states = offers.map((offer) => stock(offer.availability));
    const status = states.includes("in_stock") ? "in_stock" as const
      : states.length > 0 && states.every((value) => value === "out_of_stock")
        ? "out_of_stock" as const
        : "unknown" as const;
    return { variant, offers, status };
  });
  const anyInStock = observations.some((item) => item.status === "in_stock");
  const allKnownOut = observations.length > 0 && observations.every((item) => item.status === "out_of_stock");
  const stockStatus = anyInStock ? "in_stock" as const : allKnownOut ? "out_of_stock" as const : "unknown" as const;
  const rawSizes = observations
    .filter((item) => item.status === "in_stock")
    .flatMap((item) => [text(item.variant.size), ...item.offers.map((offer) => text(offer.size))])
    .filter((value): value is string => Boolean(value));
  const sizes = [...new Set(rawSizes.map((value) => value.toUpperCase()))];
  const allOffers = observations.flatMap((item) => item.offers);
  const pricedOffers = (anyInStock
    ? observations.filter((item) => item.status === "in_stock").flatMap((item) => item.offers)
    : allOffers)
    .map((offer) => ({ price: number(offer.price), currency: text(offer.priceCurrency) }))
    .filter((offer): offer is { price: number; currency: string | undefined } => offer.price !== null)
    .sort((left, right) => left.price - right.price);
  const offer = pricedOffers[0];
  const productImages = Array.isArray(product.image) ? product.image : product.image ? [product.image] : [];
  // ProductGroup markup (notably About You) often stores the shared gallery
  // only on each size variant. Pulling from every variant keeps the importer
  // useful without having to interact with the product gallery.
  const variantImages = variants.flatMap((variant) => (
    Array.isArray(variant.image) ? variant.image : variant.image ? [variant.image] : []
  ));
  const rawImages = [...productImages, ...variantImages];
  const images = [...new Set(rawImages.flatMap((value) => {
    const direct = text(value);
    const nested = text(record(value)?.url) ?? text(record(value)?.contentUrl);
    const resolved = direct ?? nested;
    return resolved ? [resolved] : [];
  }))];
  const name = text(product.name);
  if (!name) return null;
  let url = pageUrl;
  try {
    const candidate = new URL(text(product.url) ?? pageUrl, pageUrl);
    if (candidate.hostname === new URL(pageUrl).hostname) url = candidate.href;
  } catch {
    // Retain the already validated requested URL.
  }
  const sourceId = text(product.productGroupID)
    ?? text(product.sku)
    ?? text(product.productID)
    ?? new URL(url).pathname;
  const material = Array.isArray(product.material) ? product.material : product.material ? [product.material] : [];
  const firstVariant = variants[0];
  const sizeAvailabilityKnown = sizes.length > 0 || stockStatus === "out_of_stock";
  return {
    sourceId,
    url,
    brand: text(product.brand) ?? text(record(product.brand)?.name) ?? "Unknown",
    name,
    description: text(product.description),
    price: offer?.price ?? null,
    currency: offer?.currency,
    category: text(product.category),
    color: text(product.color) ?? text(firstVariant?.color),
    materials: material.map(text).filter((value): value is string => Boolean(value)),
    images,
    rawSizes: [...new Set(rawSizes)],
    sizes,
    stockStatus,
    ...(stockStatus !== "unknown" ? {
      available: stockStatus === "in_stock",
      stockCheckedAt: observedAt,
    } : {}),
    ...(offer ? { priceCheckedAt: observedAt } : {}),
    ...(sizeAvailabilityKnown ? { sizesCheckedAt: observedAt } : {}),
    attributes: {
      detailCaptured: true,
      sizeAvailabilityKnown,
      rawSizes: [...new Set(rawSizes)],
      ...returnPolicy(product, allOffers),
    },
  };
}

export function genericJsonLdAdapter(host: string): ShopAdapter {
  return {
    id: `generic-${host.replace(/[^a-z0-9]+/gi, "-")}`,
    label: `Generic JSON-LD (${host})`,
    allowedHosts: [host],
    matches(url) {
      return url.hostname === host;
    },
    async extractListing(page) {
      const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const image = anchor.querySelector<HTMLImageElement>("img");
        const label = (anchor.textContent ?? image?.alt ?? "").trim();
        if (!label || !image) return [];
        return [{ url: anchor.href, name: label, image: image.currentSrc || image.src }];
      }));
      return links.map((link) => ({ name: link.name, url: link.url, images: [link.image] }));
    },
    async extractDetail(page) {
      return extractGenericJsonLdProduct(await page.content(), page.url());
    },
    extractDetailHtml(html, pageUrl) {
      return extractGenericJsonLdProduct(html, pageUrl);
    },
  };
}
