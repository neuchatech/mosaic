import type {
  DiscoveryIntent,
  DiscoveryListingTarget,
  RawProduct,
  ShopAdapter,
} from "../types";

const ALIEXPRESS_HOSTS = ["www.aliexpress.com", "aliexpress.com", "m.aliexpress.com", "de.aliexpress.com", "fr.aliexpress.com"];
const ITEM_ID_PATTERN = /\/item\/(?:[^/]+\/)?(\d{8,})\.html/i;

function isAliExpressHost(hostname: string): boolean {
  return hostname === "aliexpress.com" || hostname.endsWith(".aliexpress.com");
}

function parseLocalizedNumber(value: string): number | null {
  let compact = value.replace(/[\s\u00a0'’]/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    compact = `${compact.slice(0, decimal).replace(/[.,]/g, "")}.${compact.slice(decimal + 1)}`;
  } else if (comma >= 0) {
    compact = /^\d{1,3}(?:,\d{3})+$/.test(compact)
      ? compact.replace(/,/g, "")
      : compact.replace(",", ".");
  } else if (dot >= 0 && /^\d{1,3}(?:\.\d{3})+$/.test(compact)) {
    compact = compact.replace(/\./g, "");
  }
  const number = Number(compact);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Only returns a price when the public text explicitly labels it as CHF. */
export function parseAliExpressChfPrice(text: string): number | null {
  const prefix = text.match(/(?:CHF|Fr\.?)\s*([0-9][0-9\s\u00a0'’.,]*)/i);
  if (prefix) return parseLocalizedNumber(prefix[1]);
  const suffix = text.match(/([0-9][0-9\s\u00a0'’.,]*)\s*(?:CHF|Fr\.?)(?![a-z])/i);
  return suffix ? parseLocalizedNumber(suffix[1]) : null;
}

export function aliExpressSourceId(input: string | URL): string | null {
  const url = input instanceof URL ? input : new URL(input, "https://www.aliexpress.com");
  return url.pathname.match(ITEM_ID_PATTERN)?.[1] ?? null;
}

export function canonicalAliExpressProductUrl(input: string | URL): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, "https://www.aliexpress.com");
  if (!isAliExpressHost(url.hostname)) {
    throw new Error(`AliExpress discovery does not allow host ${url.hostname}.`);
  }
  const sourceId = aliExpressSourceId(url);
  if (!sourceId) throw new Error(`Not a public AliExpress item URL: ${url.href}`);
  return `https://www.aliexpress.com/item/${sourceId}.html`;
}

export function classifyAliExpressAccessBlock(input: {
  pageUrl: string;
  status?: number;
  title?: string;
  bodyText?: string;
  hasBlockingElement?: boolean;
}): string | null {
  if ([401, 403, 429, 503].includes(input.status ?? 0)) {
    return `AliExpress stopped public access with HTTP ${input.status}; no bypass was attempted.`;
  }
  const url = new URL(input.pageUrl);
  if (/\/(?:login|signin|account|p\/captcha|punish)(?:\/|$)/i.test(url.pathname)) {
    return "AliExpress redirected to login or access verification; no bypass was attempted.";
  }
  const challenge = `${input.title ?? ""}\n${input.bodyText ?? ""}`.toLocaleLowerCase();
  if (/captcha|verify (?:that )?you are human|security verification|slide to verify|unusual traffic|access denied|just a moment|checking your browser|cloudflare ray id|temporarily blocked|punish page|rgv587/.test(challenge)) {
    return "AliExpress displayed a CAPTCHA or anti-bot verification page; no bypass was attempted.";
  }
  if (input.hasBlockingElement) {
    return "AliExpress requires login or CAPTCHA verification; no bypass was attempted.";
  }
  return null;
}

function queryWithCategory(intent: DiscoveryIntent): string {
  const parts = [intent.query?.trim(), intent.category?.trim()].filter(Boolean) as string[];
  return [...new Set(parts)].join(" ").trim();
}

export function buildAliExpressDiscoveryTargets(intent: DiscoveryIntent): DiscoveryListingTarget[] {
  if (intent.source !== "aliexpress") throw new Error("AliExpress discovery requires source 'aliexpress'.");
  const query = queryWithCategory(intent);
  if (!intent.listingUrl && !query) {
    throw new Error("AliExpress discovery requires a query, category, or exact public listing URL.");
  }
  const url = intent.listingUrl
    ? new URL(intent.listingUrl)
    : new URL(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(query.toLocaleLowerCase().replace(/\s+/g, "-"))}.html`);
  if (!isAliExpressHost(url.hostname)) {
    throw new Error(`AliExpress discovery does not allow host ${url.hostname}.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`AliExpress discovery requires HTTPS, not ${url.protocol}`);
  }
  if (query) url.searchParams.set("SearchText", query);
  return [{
    url: url.href,
    appliedFilters: {
      query: query ? "listing" : "unsupported",
      category: intent.category?.trim() ? "intent_only" : "unsupported",
      sizes: intent.sizes?.length ? "intent_only" : "unsupported",
      price: intent.minPrice !== undefined || intent.maxPrice !== undefined ? "post_fetch" : "unsupported",
    },
  }];
}

export function normalizeAliExpressListingCard(input: {
  url: string;
  name: string;
  image?: string;
  text: string;
}): RawProduct | null {
  let url: string;
  try {
    url = canonicalAliExpressProductUrl(input.url);
  } catch {
    return null;
  }
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return {
    sourceId: aliExpressSourceId(url) ?? undefined,
    url,
    brand: "Unknown",
    name,
    price: parseAliExpressChfPrice(input.text),
    currency: "CHF",
    images: input.image && !input.image.startsWith("data:") ? [input.image] : [],
    rawSizes: [],
    sizes: [],
    stockStatus: "unknown",
    attributes: {
      listingText: input.text.slice(0, 500),
      discoveryOnly: true,
      sizeAvailabilityKnown: false,
    },
  };
}

export type AliExpressDetailObservation = {
  url: string;
  name: string;
  brand?: string;
  description?: string;
  images: string[];
  color?: string;
  material?: string;
  offerPrice?: unknown;
  offerCurrency?: string;
  bodyText: string;
  stockStatus: string;
  sizeCandidates: string[];
};

export function normalizeAliExpressDetail(
  raw: AliExpressDetailObservation,
  observedAt = new Date().toISOString(),
): RawProduct | null {
  if (!raw.name.trim()) return null;
  let url: string;
  try {
    url = canonicalAliExpressProductUrl(raw.url);
  } catch {
    return null;
  }
  const explicitCurrency = String(raw.offerCurrency ?? "").toUpperCase();
  const numericOffer = Number(raw.offerPrice);
  const visibleChfPrice = parseAliExpressChfPrice(raw.bodyText);
  const price = explicitCurrency === "CHF" && Number.isFinite(numericOffer) && numericOffer >= 0
    ? numericOffer
    : visibleChfPrice;
  const rawSizes = [...new Set(raw.sizeCandidates.map((value) => value.trim()).filter(Boolean))];
  const sizes = rawSizes.map((value) => value.toUpperCase());
  const stockStatus = raw.stockStatus === "in_stock" || raw.stockStatus === "out_of_stock"
    ? raw.stockStatus
    : "unknown" as const;
  const reliableStock = stockStatus === "in_stock" || stockStatus === "out_of_stock";
  const reliableSizes = sizes.length > 0 || stockStatus === "out_of_stock";
  return {
    sourceId: aliExpressSourceId(url) ?? undefined,
    url,
    brand: raw.brand || "Unknown",
    name: raw.name,
    description: raw.description || undefined,
    price,
    currency: "CHF",
    color: raw.color || undefined,
    materials: raw.material ? [String(raw.material)] : [],
    images: raw.images,
    stockStatus,
    rawSizes,
    sizes,
    ...(reliableStock ? { available: stockStatus === "in_stock", stockCheckedAt: observedAt } : {}),
    ...(price !== null ? { priceCheckedAt: observedAt } : {}),
    ...(reliableSizes ? { sizesCheckedAt: observedAt } : {}),
    attributes: {
      detailCaptured: true,
      sizeAvailabilityKnown: reliableSizes,
      rawSizes,
    },
  };
}

export const aliExpressAdapter: ShopAdapter = {
  id: "aliexpress",
  label: "AliExpress (public)",
  allowedHosts: ALIEXPRESS_HOSTS,
  matches(url) {
    return isAliExpressHost(url.hostname);
  },
  async extractListing(page) {
    const candidates = await page.locator('a[href*="/item/"][href*=".html"]').evaluateAll((anchors) =>
      anchors.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const card = anchor.closest<HTMLElement>("[class*='card'], [class*='item'], li, article") ?? anchor;
        const image = anchor.querySelector<HTMLImageElement>("img") ?? card.querySelector<HTMLImageElement>("img");
        const imageUrl = image?.currentSrc
          || image?.src
          || image?.getAttribute("data-src")
          || image?.getAttribute("data-lazy-src")
          || "";
        const text = (card.textContent ?? anchor.textContent ?? "").replace(/\s+/g, " ").trim();
        const name = anchor.getAttribute("title")
          || image?.alt
          || anchor.getAttribute("aria-label")
          || text.split(/(?:CHF|Fr\.?|US\s*\$|\$)/i)[0]
          || "";
        if (!anchor.href || !name.trim()) return [];
        return [{ url: anchor.href, name, image: imageUrl, text }];
      }),
    );
    const unique = new Map<string, RawProduct>();
    for (const candidate of candidates) {
      const product = normalizeAliExpressListingCard(candidate);
      if (product?.sourceId && !unique.has(product.sourceId)) unique.set(product.sourceId, product);
    }
    return [...unique.values()];
  },
  async extractDetail(page) {
    const raw = await page.evaluate(() => {
      const jsonLd = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).flatMap((script) => {
        try {
          const parsed = JSON.parse(script.textContent ?? "null");
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
      const product = jsonLd.find((value) => value?.["@type"] === "Product");
      const offers = Array.isArray(product?.offers) ? product.offers : product?.offers ? [product.offers] : [];
      const offer = offers[0];
      const meta = (property: string) => document.querySelector<HTMLMetaElement>(
        `meta[property="${property}"], meta[name="${property}"]`,
      )?.content?.trim() || "";
      const title = product?.name || meta("og:title") || document.querySelector("h1")?.textContent?.trim() || "";
      const imageValues = Array.isArray(product?.image)
        ? product.image
        : product?.image
          ? [product.image]
          : meta("og:image")
            ? [meta("og:image")]
            : [];
      const images = imageValues.flatMap((value: unknown) => {
        if (typeof value === "string" && value.trim()) return [value];
        if (value && typeof value === "object" && "url" in value) {
          const url = (value as { url?: unknown }).url;
          return typeof url === "string" && url.trim() ? [url] : [];
        }
        return [];
      });
      const availabilities = offers
        .map((candidateOffer: { availability?: unknown }) => String(candidateOffer?.availability ?? "").toLocaleLowerCase())
        .filter(Boolean);
      const stockStatus = availabilities.some((availability: string) => availability.includes("instock") || availability.includes("limitedavailability"))
        ? "in_stock"
        : availabilities.length > 0 && availabilities.every((availability: string) => availability.includes("outofstock"))
          ? "out_of_stock"
          : "unknown";
      const sizeCandidates: string[] = [];
      for (const candidateOffer of offers) {
        const candidateAvailability = String(candidateOffer?.availability ?? "").toLocaleLowerCase();
        if (!candidateAvailability.includes("instock") && !candidateAvailability.includes("limitedavailability")) continue;
        const size = candidateOffer?.size ?? candidateOffer?.itemOffered?.size;
        if (typeof size === "string" && size.trim()) sizeCandidates.push(size.trim());
      }
      return {
        url: location.href,
        name: String(title),
        brand: typeof product?.brand === "string" ? product.brand : product?.brand?.name,
        description: product?.description || meta("og:description"),
        images,
        color: product?.color,
        material: product?.material,
        offerPrice: offer?.price ?? meta("product:price:amount"),
        offerCurrency: offer?.priceCurrency ?? meta("product:price:currency"),
        bodyText: document.body?.innerText?.slice(0, 8_000) ?? "",
        stockStatus,
        sizeCandidates,
      };
    });
    return normalizeAliExpressDetail(raw);
  },
  discovery: {
    buildListingTargets: buildAliExpressDiscoveryTargets,
    canonicalProductUrl(url) {
      return canonicalAliExpressProductUrl(url);
    },
    classifyAccessBlock: classifyAliExpressAccessBlock,
  },
};
