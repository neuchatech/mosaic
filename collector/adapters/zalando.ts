import type {
  DiscoveryIntent,
  DiscoveryListingTarget,
  RawProduct,
  ShopAdapter,
} from "../types";
import { jsonCallArgumentsFromHtml, jsonLdValuesFromHtml, visitJson } from "../html";

const LETTER_SIZE_PATTERN = /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/i;
const NUMBER_SIZE_PATTERN = /^(?:(?:EU|IT|FR|UK|US)\s*)?\d{1,3}(?:[.,]5)?$/i;
const JEANS_SIZE_PATTERN = /^(?:W\s*)?(\d{2,3})\s*(?:\/|x|-)\s*(?:L\s*)?(\d{2,3})$/i;

function cleanSizeLabel(value: string): string {
  return value
    .replace(/^(?:taille|size|grösse)\s*:?\s*/i, "")
    .replace(/\s+(?:disponible|available|verfügbar)$/i, "")
    // Zalando's JSON-LD uses MxR/LxR for the regular-length variant.
    .replace(/\s*x\s*R$/i, "")
    .trim();
}

export function canonicalizeZalandoSize(value: string): string | null {
  const cleaned = cleanSizeLabel(value);
  const jeans = cleaned.match(JEANS_SIZE_PATTERN);
  if (jeans) return `W${jeans[1]}/L${jeans[2]}`;
  if (LETTER_SIZE_PATTERN.test(cleaned)) return cleaned.toUpperCase();
  if (NUMBER_SIZE_PATTERN.test(cleaned)) {
    return cleaned.toUpperCase().replace(/\s+/g, " ").replace(",", ".");
  }
  return null;
}

export function normalizeZalandoSizes(values: string[]): string[] {
  const cleaned = values.flatMap((value) => value
    .split(/[\n;|]/)
    .flatMap((part) => {
      // Keep a single decimal half-size (48,5), while still splitting compact
      // retailer lists such as "48,50".
      const candidate = cleanSizeLabel(part);
      return NUMBER_SIZE_PATTERN.test(candidate) && /,5$/i.test(candidate)
        ? [part]
        : part.split(",");
    })
    .map(canonicalizeZalandoSize)
    .filter((part): part is string => part !== null));
  return [...new Set(cleaned)];
}

function priceFromText(text: string): number | null {
  const match = text.match(/(?:CHF|Fr\.?)[\s\u00a0]*([0-9'’.,]+)/i);
  if (!match) return null;
  return Number(match[1].replace(/[’']/g, "").replace(",", "."));
}

function pricesFromText(text: string): number[] {
  return [...text.matchAll(/(?:CHF|Fr\.?)[\s\u00a0]*([0-9'’.,]+)/gi)]
    .map((match) => Number(match[1].replace(/[’']/g, "").replace(",", ".")))
    .filter(Number.isFinite);
}

export function zalandoSourceIdFromUrl(value: string | URL): string | undefined {
  const url = value instanceof URL ? value : new URL(value);
  const stem = url.pathname.split("/").pop()?.replace(/\.html$/i, "") ?? "";
  return stem.match(/([a-z0-9]{8,}-[a-z0-9]{3})$/i)?.[1]?.toUpperCase();
}

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

function finiteNumber(value: unknown): number | null {
  const result = Number(value);
  return value !== null && value !== undefined && String(value).trim() && Number.isFinite(result) && result >= 0
    ? result
    : null;
}

function availability(value: unknown): "in_stock" | "out_of_stock" | "unknown" {
  const normalized = String(value ?? "").toLocaleLowerCase();
  if (normalized.includes("instock") || normalized.includes("limitedavailability") || normalized.includes("preorder")) {
    return "in_stock";
  }
  return normalized.includes("outofstock") ? "out_of_stock" : "unknown";
}

function imageUrl(value: unknown): string | undefined {
  const direct = text(value);
  if (direct) return direct;
  return text(record(value)?.uri);
}

function listingImage(product: JsonRecord): string | undefined {
  const gallery = records(product.multiSizeGallery);
  return imageUrl(record(gallery[0]?.mediumMedia)?.uri)
    ?? imageUrl(record(gallery[0]?.largeMedia)?.uri)
    ?? imageUrl(record(product.mediumModelImage)?.uri)
    ?? imageUrl(record(product.largeModelImage)?.uri)
    ?? imageUrl(record(product.mediumPackshotImage)?.uri);
}

function canonicalZalandoUrl(value: unknown, fallback: string): string | null {
  try {
    const url = new URL(text(value) ?? fallback, fallback);
    if (!["fr.zalando.ch", "www.zalando.ch", "zalando.ch"].includes(url.hostname)) return null;
    if (!url.pathname.endsWith(".html")) return null;
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Parse the product-card cache Zalando embeds in its server-rendered listing. */
export function extractZalandoListingHtml(html: string, pageUrl: string): RawProduct[] {
  const products = new Map<string, RawProduct>();
  const payloads = [
    ...jsonCallArgumentsFromHtml(html, "runtime['hydratePartial']"),
    ...jsonCallArgumentsFromHtml(html, "window.__hydrationDataConsume"),
  ];
  for (const payload of payloads) {
    visitJson(payload, (candidate) => {
      const product = record(record(candidate.data)?.product);
      if (!product) return;
      const name = text(product.name);
      const url = canonicalZalandoUrl(product.uri, pageUrl);
      const sourceId = text(product.sku) ?? text(product.id)?.replace(/^ern:product::/, "");
      if (!name || !url || !sourceId) return;
      const brand = text(record(product.brand)?.name) ?? "Unknown";
      const displayPrice = record(product.displayPrice);
      const current = finiteNumber(displayPrice?.trackingCurrentAmount)
        ?? (finiteNumber(record(displayPrice?.promotional)?.amount) ?? 0) / 100;
      const originalAmount = finiteNumber(record(displayPrice?.original)?.amount);
      const listedOriginal = originalAmount === null ? null : originalAmount / 100;
      const originalPrice = listedOriginal !== null && current > 0 && listedOriginal > current ? listedOriginal : null;
      const image = listingImage(product);
      products.set(sourceId, {
        sourceId,
        url,
        brand,
        name,
        price: current > 0 ? current : null,
        originalPrice,
        currency: text(record(displayPrice?.original)?.currency) ?? "CHF",
        images: image ? [image] : [],
        rawSizes: [],
        sizes: [],
        stockStatus: "unknown",
        attributes: {
          discoveryOnly: true,
          sizeAvailabilityKnown: false,
          ...(text(product.silhouette) ? { silhouette: text(product.silhouette)! } : {}),
        },
      });
    });
  }
  return [...products.values()];
}

function returnPolicyFields(product: JsonRecord, offers: JsonRecord[]): {
  returnsLabel?: string;
  returnsWindowDays?: number;
} {
  const rawPolicy = offers[0]?.hasMerchantReturnPolicy ?? product.hasMerchantReturnPolicy;
  const policy = records(rawPolicy)[0];
  if (!policy) return {};
  const days = finiteNumber(policy.merchantReturnDays);
  const category = String(policy.returnPolicyCategory ?? "").toLocaleLowerCase();
  return {
    returnsLabel: category.includes("notpermitted")
      ? "Retours non acceptés"
      : days !== null ? `${days} jours` : "Politique de retour disponible",
    ...(days !== null ? { returnsWindowDays: days } : {}),
  };
}

/** Parse Product or ProductGroup JSON-LD, including exact in-stock variants. */
export function extractZalandoDetailHtml(
  html: string,
  pageUrl: string,
  observedAt = new Date().toISOString(),
): RawProduct | null {
  const values = jsonLdValuesFromHtml(html);
  const product = values.map(record).find((value) => value?.["@type"] === "ProductGroup")
    ?? values.map(record).find((value) => value?.["@type"] === "Product");
  if (!product) return null;

  const variants = product["@type"] === "ProductGroup" ? records(product.hasVariant) : [product];
  const variantObservations = variants.map((variant) => {
    const offers = records(variant.offers);
    const states = offers.map((offer) => availability(offer.availability));
    const state = states.includes("in_stock")
      ? "in_stock" as const
      : states.length > 0 && states.every((value) => value === "out_of_stock")
        ? "out_of_stock" as const
        : "unknown" as const;
    return { variant, offers, state };
  });
  const knownVariants = variantObservations.filter((item) => item.state !== "unknown");
  const anyInStock = variantObservations.some((item) => item.state === "in_stock");
  const allOutOfStock = variantObservations.length > 0
    && knownVariants.length === variantObservations.length
    && knownVariants.every((item) => item.state === "out_of_stock");
  const stockStatus = anyInStock ? "in_stock" as const
    : allOutOfStock ? "out_of_stock" as const
      : "unknown" as const;
  const rawSizes = variantObservations
    .filter((item) => item.state === "in_stock")
    .flatMap((item) => [text(item.variant.size), ...item.offers.map((offer) => text(offer.size))])
    .filter((value): value is string => Boolean(value));
  const sizes = normalizeZalandoSizes(rawSizes);
  const allOffers = variantObservations.flatMap((item) => item.offers);
  const pricedOffers = (anyInStock
    ? variantObservations.filter((item) => item.state === "in_stock").flatMap((item) => item.offers)
    : allOffers)
    .map((offer) => ({ price: finiteNumber(offer.price), currency: text(offer.priceCurrency) }))
    .filter((offer): offer is { price: number; currency: string | undefined } => offer.price !== null);
  const cheapest = pricedOffers.sort((left, right) => left.price - right.price)[0];
  const images = (Array.isArray(product.image) ? product.image : [product.image])
    .map(imageUrl)
    .filter((value): value is string => Boolean(value));
  const brand = text(product.brand) ?? text(record(product.brand)?.name);
  const sourceId = text(product.productGroupID) ?? text(product.sku) ?? text(product.productID);
  const url = canonicalZalandoUrl(product.url, pageUrl) ?? canonicalZalandoUrl(pageUrl, pageUrl);
  const name = text(product.name);
  if (!sourceId || !url || !name) return null;
  const sizeAvailabilityKnown = sizes.length > 0 || stockStatus === "out_of_stock";
  const policies = returnPolicyFields(product, allOffers);
  const materials = (Array.isArray(product.material) ? product.material : [product.material])
    .map(text)
    .filter((value): value is string => Boolean(value));
  return {
    sourceId,
    url,
    brand: brand ?? "Unknown",
    name,
    description: text(product.description),
    color: text(product.color),
    materials,
    images,
    price: cheapest?.price ?? null,
    currency: cheapest?.currency ?? "CHF",
    stockStatus,
    rawSizes: [...new Set(rawSizes)],
    sizes,
    ...(stockStatus !== "unknown" ? {
      available: stockStatus === "in_stock",
      stockCheckedAt: observedAt,
    } : {}),
    ...(cheapest ? { priceCheckedAt: observedAt } : {}),
    ...(sizeAvailabilityKnown ? { sizesCheckedAt: observedAt } : {}),
    attributes: {
      detailCaptured: true,
      sizeAvailabilityKnown,
      rawSizes: [...new Set(rawSizes)],
      ...policies,
    },
  };
}

const ZALANDO_CATEGORY_PATHS: Record<string, string> = {
  all: "mode-homme",
  clothing: "mode-homme",
  clothes: "mode-homme",
  vetements: "mode-homme",
  vêtements: "mode-homme",
  jackets: "vestes-homme",
  jacket: "vestes-homme",
  vestes: "vestes-homme",
  veste: "vestes-homme",
  trousers: "pantalons-homme",
  pants: "pantalons-homme",
  pantalons: "pantalons-homme",
  pantalon: "pantalons-homme",
  jeans: "jeans-homme",
  knitwear: "pulls-gilets-homme",
  knits: "pulls-gilets-homme",
  mailles: "pulls-gilets-homme",
  maille: "pulls-gilets-homme",
  cardigans: "pulls-gilets-homme",
  cardigan: "pulls-gilets-homme",
  shirts: "chemises-homme",
  shirt: "chemises-homme",
  chemises: "chemises-homme",
  chemise: "chemises-homme",
  "t-shirts": "t-shirts-polos-homme",
  "t-shirt": "t-shirts-polos-homme",
  tshirts: "t-shirts-polos-homme",
  tshirt: "t-shirts-polos-homme",
  shoes: "chaussures-homme",
  shoe: "chaussures-homme",
  chaussures: "chaussures-homme",
  chaussure: "chaussures-homme",
  accessories: "accessoires-homme",
  accessoires: "accessoires-homme",
};

function discoveryCategoryPath(category?: string): string {
  if (!category?.trim()) return ZALANDO_CATEGORY_PATHS.all;
  const key = category.trim().toLocaleLowerCase("fr-CH");
  return ZALANDO_CATEGORY_PATHS[key] ?? ZALANDO_CATEGORY_PATHS.all;
}

function cleanDiscoverySize(size: string): string | null {
  const normalized = canonicalizeZalandoSize(size);
  // Listing path filters are only used for the stable, simple clothing sizes.
  return normalized && LETTER_SIZE_PATTERN.test(normalized) ? normalized : null;
}

function withoutKnownSizeFilter(url: URL): URL {
  const result = new URL(url);
  result.pathname = result.pathname.replace(/\/__taille-[^/]+\/?$/i, "/");
  return result;
}

function withZalandoListingSize(url: URL, size: string): URL {
  const result = withoutKnownSizeFilter(url);
  result.pathname = `${result.pathname.replace(/\/+$/, "")}/__taille-${encodeURIComponent(size)}/`;
  return result;
}

/**
 * Builds a finite listing plan. M OR L deliberately becomes two known public
 * Zalando filters whose results are unioned by DiscoveryService. We do not
 * claim an undocumented multi-size URL syntax.
 */
export function buildZalandoDiscoveryTargets(intent: DiscoveryIntent): DiscoveryListingTarget[] {
  if (intent.source !== "zalando-ch") throw new Error("Zalando discovery requires source 'zalando-ch'.");
  const base = intent.listingUrl
    ? new URL(intent.listingUrl)
    : new URL(`https://fr.zalando.ch/${discoveryCategoryPath(intent.category)}/`);
  if (!["fr.zalando.ch", "www.zalando.ch", "zalando.ch"].includes(base.hostname)) {
    throw new Error(`Zalando discovery does not allow host ${base.hostname}.`);
  }
  if (base.protocol !== "https:") {
    throw new Error(`Zalando discovery requires HTTPS, not ${base.protocol}`);
  }
  if (intent.query?.trim()) base.searchParams.set("q", intent.query.trim());

  const sizes = [...new Set((intent.sizes ?? []).map(cleanDiscoverySize).filter((size): size is string => Boolean(size)))];
  const common = {
    query: intent.query?.trim() ? "listing" as const : "unsupported" as const,
    category: intent.category?.trim() || !intent.listingUrl ? "listing" as const : "unsupported" as const,
    price: intent.minPrice !== undefined || intent.maxPrice !== undefined
      ? "post_fetch" as const
      : "unsupported" as const,
  };
  if (sizes.length === 0 || (intent.sizeMode === "all" && sizes.length > 1)) {
    return [{
      url: base.href,
      appliedFilters: {
        ...common,
        sizes: sizes.length > 0 ? "intent_only" : "unsupported",
      },
    }];
  }
  return sizes.map((size) => ({
    url: withZalandoListingSize(base, size).href,
    matchedSizeIntent: size,
    appliedFilters: { ...common, sizes: "listing" },
  }));
}

export const zalandoAdapter: ShopAdapter = {
  id: "zalando-ch",
  label: "Zalando Suisse",
  allowedHosts: ["www.zalando.ch", "fr.zalando.ch", "zalando.ch"],
  matches(url) {
    return this.allowedHosts.includes(url.hostname);
  },
  async extractListing(page) {
    const cards = await page.locator("article").evaluateAll((articles) =>
      articles.flatMap((article) => {
        const heading = article.querySelector("h3");
        const link = heading?.closest<HTMLAnchorElement>('a[href*=".html"]')
          ?? article.querySelector<HTMLAnchorElement>('a[href*=".html"]');
        const image = article.querySelector<HTMLImageElement>("img");
        const headingParts = Array.from(heading?.children ?? [])
          .map((node) => (node.textContent ?? "").trim())
          .filter(Boolean);
        const brand = headingParts[0] ?? "";
        const name = headingParts.slice(1).join(" ") || (heading?.textContent ?? image?.alt ?? "").trim();
        const text = (article.textContent ?? "").trim();
        if (!link || !name || !text) return [];
        return [{
          url: link.href,
          image: image?.currentSrc || image?.src || "",
          alt: image?.alt || "",
          brand,
          name,
          text,
        }];
      }),
    );

    return cards.map((card) => {
      const prices = pricesFromText(card.text);
      const price = prices[0] ?? priceFromText(card.text);
      const sourceId = zalandoSourceIdFromUrl(card.url)
        ?? new URL(card.url).pathname.split("/").pop()?.replace(/\.html$/, "");
      return {
        sourceId,
        url: card.url,
        brand: card.brand || "Unknown",
        name: card.name || card.alt || "Article Zalando",
        price,
        originalPrice: prices.length > 1 ? prices.at(-1) : null,
        currency: "CHF",
        images: card.image ? [card.image] : [],
        rawSizes: [],
        sizes: [],
        stockStatus: "unknown" as const,
        attributes: {
          listingText: card.text.slice(0, 500),
          discoveryOnly: true,
          sizeAvailabilityKnown: false,
        },
      };
    });
  },
  extractListingHtml(html, pageUrl) {
    return extractZalandoListingHtml(html, pageUrl);
  },
  async extractDetail(page) {
    return extractZalandoDetailHtml(await page.content(), page.url());
  },
  extractDetailHtml(html, pageUrl) {
    return extractZalandoDetailHtml(html, pageUrl);
  },
  discovery: {
    buildListingTargets: buildZalandoDiscoveryTargets,
    canonicalProductUrl(url) {
      const canonical = new URL(url);
      canonical.hash = "";
      canonical.search = "";
      return canonical.href;
    },
  },
};
