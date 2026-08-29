import type { DiscoveryIntent, DiscoveryListingTarget, RawProduct, ShopAdapter } from "../types";

const ABOUT_YOU_HOSTS = ["www.aboutyou.ch", "aboutyou.ch", "fr.aboutyou.ch", "en.aboutyou.ch"];

const ABOUT_YOU_MEN_CATEGORIES: Record<string, string> = {
  Vestes: "/c/men/clothing/jackets-20320",
  Pantalons: "/c/men/clothing/pants-20330",
  Mailles: "/c/men/clothing/sweaters-cardigans-20322",
  Chemises: "/c/men/clothing/button-up-shirts-20319",
  "T-shirts": "/c/men/clothing/t-shirts-20324",
  Chaussures: "/c/men/shoes-20215",
  Accessoires: "/c/men/accessories-20211",
};

type AboutYouListingCard = {
  url: string;
  brand?: string;
  name?: string;
  image?: string;
  alt?: string;
  text: string;
};

function localizedNumber(value: string): number | null {
  const cleaned = value.replace(/[’'\s]/g, "").replace(/,(?=\d{1,2}$)/, ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function aboutYouSourceIdFromUrl(value: string | URL): string | undefined {
  const url = value instanceof URL ? value : new URL(value, "https://www.aboutyou.ch");
  const match = url.pathname.match(/\/p\/[^/]+\/[^/]+-(\d+)\/?$/);
  return match?.[1];
}

export function canonicalAboutYouProductUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value) : new URL(value, "https://www.aboutyou.ch");
  url.protocol = "https:";
  url.hostname = "www.aboutyou.ch";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function aboutYouSizesFromText(value: string): { known: boolean; sizes: string[] } {
  const match = value.match(
    /(?:Available sizes|Tailles disponibles|Verf(?:ü|u)gbare Gr(?:ö|o)(?:ß|ss)en)\s*:\s*([^\n]+?)(?=(?:Add to basket|Ajouter au panier|In den Warenkorb|Originally:|Prix initial\s*:|Urspr(?:ü|u)nglich\s*:|See more info|Plus d['’]infos|Mehr Infos|$))/i,
  );
  if (!match) return { known: false, sizes: [] };
  const sizes = match[1]!
    .split(",")
    .map((size) => size.replace(/\s+/g, " ").trim().toUpperCase())
    .filter(Boolean);
  return { known: sizes.length > 0, sizes: [...new Set(sizes)] };
}

function pricesFromText(value: string): number[] {
  return [...value.matchAll(/CHF\s*([\d’'.,]+)/gi)]
    .map((match) => localizedNumber(match[1]!))
    .filter((price): price is number => price !== null);
}

export function normalizeAboutYouListingCard(
  card: AboutYouListingCard,
  observedAt = new Date().toISOString(),
): RawProduct | null {
  const sourceId = aboutYouSourceIdFromUrl(card.url);
  const name = card.name?.trim() || card.alt?.replace(/:\s*(?:front|back).*$/i, "").trim();
  if (!sourceId || !name) return null;
  const prices = pricesFromText(card.text);
  const sizeObservation = aboutYouSizesFromText(card.text);
  const color = card.alt?.match(/\b(?:in|en|auf)\s+([^:]+)\s*:/i)?.[1]?.trim();
  return {
    sourceId,
    url: canonicalAboutYouProductUrl(card.url),
    brand: card.brand?.trim() || "Unknown",
    name,
    price: prices[0] ?? null,
    originalPrice: prices.length > 1 ? prices.at(-1) : null,
    currency: "CHF",
    color,
    images: card.image ? [card.image] : [],
    rawSizes: sizeObservation.sizes,
    sizes: sizeObservation.sizes,
    stockStatus: sizeObservation.known ? "in_stock" : "unknown",
    ...(sizeObservation.known ? {
      available: true,
      stockCheckedAt: observedAt,
      sizesCheckedAt: observedAt,
    } : {}),
    ...(prices[0] !== undefined ? { priceCheckedAt: observedAt } : {}),
    attributes: {
      discoveryOnly: true,
      sizeAvailabilityKnown: sizeObservation.known,
      rawSizes: sizeObservation.sizes,
      listingText: card.text.slice(0, 700),
      returnsLabel: "30 jours",
      returnsWindowDays: 30,
    },
  };
}

export function buildAboutYouDiscoveryTargets(intent: DiscoveryIntent): DiscoveryListingTarget[] {
  if (intent.source !== "aboutyou-ch") throw new Error("About You discovery requires source 'aboutyou-ch'.");
  const categoryPath = ABOUT_YOU_MEN_CATEGORIES[intent.category ?? ""] ?? "/c/men/clothing-20290";
  const url = intent.listingUrl
    ? new URL(intent.listingUrl)
    : new URL(categoryPath, "https://www.aboutyou.ch");
  if (!ABOUT_YOU_HOSTS.includes(url.hostname)) throw new Error("About You discovery only accepts Swiss public listings.");
  return [{
    url: url.href,
    appliedFilters: {
      query: "unsupported",
      category: ABOUT_YOU_MEN_CATEGORIES[intent.category ?? ""] ? "listing" : "unsupported",
      sizes: intent.sizes?.length ? "post_fetch" : "unsupported",
      price: intent.minPrice !== undefined || intent.maxPrice !== undefined ? "post_fetch" : "unsupported",
    },
  }];
}

export const aboutYouAdapter: ShopAdapter = {
  id: "aboutyou-ch",
  label: "About You Suisse",
  allowedHosts: ABOUT_YOU_HOSTS,
  matches(url) {
    return ABOUT_YOU_HOSTS.includes(url.hostname);
  },
  async extractListing(page) {
    const cards = await page.locator('a[href*="/p/"]').evaluateAll((anchors) => anchors.flatMap((node) => {
      const anchor = node as HTMLAnchorElement;
      if (!/\/p\/[^/]+\/[^/]+-\d+\/?(?:[?#]|$)/.test(anchor.href)) return [];
      const anchorText = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      const card = /(?:Available sizes|Tailles disponibles|Verf(?:ü|u)gbare Gr(?:ö|o)(?:ß|ss)en)/i.test(anchorText)
        ? anchor
        : anchor.closest<HTMLElement>("li, article, [data-testid*='product']") ?? anchor;
      const image = card.querySelector<HTMLImageElement>("img");
      const paragraphs = [...card.querySelectorAll("p")]
        .map((paragraph) => (paragraph.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || !image) return [];
      return [{
        url: anchor.href,
        brand: paragraphs[0] ?? "",
        name: paragraphs[1] ?? "",
        image: image.currentSrc || image.src || "",
        alt: image.alt || "",
        text,
      }];
    }));
    const unique = new Map<string, RawProduct>();
    for (const card of cards) {
      const product = normalizeAboutYouListingCard(card);
      if (product?.sourceId && !unique.has(product.sourceId)) unique.set(product.sourceId, product);
    }
    return [...unique.values()];
  },
  async extractDetail(page) {
    const observedAt = new Date().toISOString();
    const raw = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      const text = (main.textContent ?? "").replace(/\s+/g, " ").trim();
      const images = [...main.querySelectorAll<HTMLImageElement>("img")]
        .filter((image) => image.naturalWidth >= 300 && image.naturalHeight >= 300)
        .map((image) => image.currentSrc || image.src)
        .filter(Boolean);
      return { text, images: [...new Set(images)] };
    });
    const prices = pricesFromText(raw.text);
    const color = raw.text.match(/Color:\s*([^]+?)(?=Size\b|Select size\b)/i)?.[1]?.trim();
    const materials = [...raw.text.matchAll(/(?:Upper material|Sleeve lining|Material):\s*([^]+?)(?=(?:Upper material|Sleeve lining|Country of origin|Manufacturer|$))/gi)]
      .map((match) => match[1]!.trim())
      .filter(Boolean);
    const fit = raw.text.match(/Style fit:\s*([^]+?)(?=The model|Size Chart|Material)/i)?.[1]?.trim();
    return {
      sourceId: aboutYouSourceIdFromUrl(page.url()),
      url: canonicalAboutYouProductUrl(page.url()),
      name: "",
      price: prices[0] ?? null,
      originalPrice: prices.length > 1 ? prices.at(-1) : null,
      currency: "CHF",
      color,
      fit,
      materials,
      images: raw.images,
      stockStatus: "unknown",
      ...(prices[0] !== undefined ? { priceCheckedAt: observedAt } : {}),
      attributes: {
        detailCaptured: true,
        sizeAvailabilityKnown: false,
        returnsLabel: "30 jours",
        returnsWindowDays: 30,
      },
    };
  },
  discovery: {
    buildListingTargets: buildAboutYouDiscoveryTargets,
    canonicalProductUrl(url) {
      return canonicalAboutYouProductUrl(url);
    },
  },
};
