import type { ShopAdapter } from "../types";

const LETTER_SIZE_PATTERN = /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/i;
const NUMBER_SIZE_PATTERN = /^(?:(?:EU|IT|FR|UK|US)\s*)?\d{1,3}(?:[.,]5)?$/i;
const JEANS_SIZE_PATTERN = /^(?:W\s*)?(\d{2,3})\s*(?:\/|x|-)\s*(?:L\s*)?(\d{2,3})$/i;

function cleanSizeLabel(value: string): string {
  return value
    .replace(/^(?:taille|size|grösse)\s*:?\s*/i, "")
    .replace(/\s+(?:disponible|available|verfügbar)$/i, "")
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
      const sourceId = new URL(card.url).pathname.split("/").pop()?.replace(/\.html$/, "");
      return {
        sourceId,
        url: card.url,
        brand: card.brand || "Unknown",
        name: card.name || card.alt || "Article Zalando",
        price,
        originalPrice: prices.length > 1 ? prices.at(-1) : null,
        currency: "CHF",
        images: card.image ? [card.image] : [],
        attributes: { listingText: card.text.slice(0, 500) },
      };
    });
  },
  async extractDetail(page) {
    const raw = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
      const values = scripts.flatMap((script) => {
        try {
          const parsed = JSON.parse(script.textContent ?? "null");
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
      const product = values.find((value) => value?.["@type"] === "Product");
      if (!product) return null;
      const offers = Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : [];
      const offer = offers[0];
      const rawReturnPolicy = offer?.hasMerchantReturnPolicy ?? product.hasMerchantReturnPolicy;
      const returnPolicy = Array.isArray(rawReturnPolicy) ? rawReturnPolicy[0] : rawReturnPolicy;
      const rawReturnDays = returnPolicy?.merchantReturnDays;
      const returnWindowDays = Number.isFinite(Number(rawReturnDays)) && Number(rawReturnDays) >= 0
        ? Number(rawReturnDays)
        : null;
      const returnPolicyCategory = String(returnPolicy?.returnPolicyCategory ?? "").toLowerCase();
      const returnsLabel = returnPolicyCategory.includes("notpermitted")
        ? "Retours non acceptés"
        : returnWindowDays !== null
          ? `${returnWindowDays} jours`
          : returnPolicy
            ? "Politique de retour disponible"
            : null;
      const sizeCandidates: string[] = [];
      const addSize = (value: unknown) => {
        if (typeof value === "string") sizeCandidates.push(value);
        if (Array.isArray(value)) value.forEach(addSize);
      };
      const normalizedAvailability = (value: unknown) => String(value ?? "").toLowerCase();
      const offerInStock = (value: unknown) => {
        const availability = normalizedAvailability(value);
        return availability.includes("instock")
          || availability.includes("limitedavailability")
          || availability.includes("preorder");
      };
      const offerOutOfStock = (value: unknown) => normalizedAvailability(value).includes("outofstock");
      let offerSizesObserved = false;
      for (const candidateOffer of offers) {
        if (!offerInStock(candidateOffer?.availability)) continue;
        const before = sizeCandidates.length;
        addSize(candidateOffer?.size);
        addSize(candidateOffer?.itemOffered?.size);
        for (const property of candidateOffer?.itemOffered?.additionalProperty ?? []) {
          if (/size|taille|grösse/i.test(String(property?.name ?? ""))) addSize(property?.value);
        }
        if (sizeCandidates.length > before) offerSizesObserved = true;
      }
      const sizeSelectors = [
        '[data-testid*="size" i] button:not([disabled]):not([aria-disabled="true"])',
        '[data-testid*="size" i] option:not([disabled])',
        'select[name*="size" i] option:not([disabled])',
        'select[aria-label*="taille" i] option:not([disabled])',
        'select[aria-label*="size" i] option:not([disabled])',
      ];
      const availableSizeElements = document.querySelectorAll<HTMLElement>(sizeSelectors.join(","));
      for (const element of availableSizeElements) {
        addSize(element.getAttribute("value"));
        addSize(element.getAttribute("aria-label"));
        addSize(element.textContent);
      }
      const allSizeSelectors = [
        '[data-testid*="size" i] button',
        '[data-testid*="size" i] option',
        'select[name*="size" i] option',
        'select[aria-label*="taille" i] option',
        'select[aria-label*="size" i] option',
      ];
      const anySizeControl = document.querySelectorAll(allSizeSelectors.join(",")).length > 0;
      const explicitInStock = offers.some((candidateOffer: { availability?: unknown }) => offerInStock(candidateOffer?.availability));
      const explicitOutOfStock = offers.length > 0
        && offers.every((candidateOffer: { availability?: unknown }) => offerOutOfStock(candidateOffer?.availability));
      const stockStatus: "in_stock" | "out_of_stock" | "unknown" = explicitInStock
        ? "in_stock"
        : explicitOutOfStock
          ? "out_of_stock"
          : "unknown";
      const rawPrice = offer?.price;
      const price = rawPrice === null || rawPrice === undefined || String(rawPrice).trim() === ""
        ? Number.NaN
        : Number(rawPrice);
      return {
        sourceId: String(product.sku ?? product.productID ?? ""),
        url: location.href,
        brand: typeof product.brand === "string" ? product.brand : product.brand?.name,
        name: product.name,
        description: product.description,
        color: product.color,
        material: product.material,
        images: Array.isArray(product.image) ? product.image : product.image ? [product.image] : [],
        price: Number.isFinite(price) && price >= 0 ? price : null,
        currency: offer?.priceCurrency,
        returnWindowDays,
        returnsLabel,
        stockStatus,
        sizesObserved: offerSizesObserved || anySizeControl || explicitOutOfStock,
        sizeCandidates,
      };
    });
    if (!raw?.name) return null;
    const rawSizes = [...new Set(raw.sizeCandidates.map(cleanSizeLabel).filter(Boolean))];
    const sizes = normalizeZalandoSizes(rawSizes);
    const observedAt = new Date().toISOString();
    const stockStatus = raw.stockStatus === "unknown" && sizes.length > 0
      ? "in_stock"
      : raw.stockStatus;
    const stockReliable = stockStatus === "in_stock" || stockStatus === "out_of_stock";
    const sizesReliable = sizes.length > 0 || stockStatus === "out_of_stock";
    return {
      ...raw,
      stockStatus,
      rawSizes,
      sizes,
      materials: raw.material ? [String(raw.material)] : [],
      colorFamily: raw.color ?? "unknown",
      ...(stockReliable ? {
        available: stockStatus === "in_stock",
        stockCheckedAt: observedAt,
      } : {}),
      ...(raw.price !== null ? { priceCheckedAt: observedAt } : {}),
      ...(sizesReliable ? { sizesCheckedAt: observedAt } : {}),
      attributes: {
        detailCaptured: true,
        sizeAvailabilityKnown: sizesReliable,
        rawSizes,
        ...(raw.returnsLabel ? { returnsLabel: raw.returnsLabel } : {}),
        ...(raw.returnWindowDays !== null ? { returnsWindowDays: raw.returnWindowDays } : {}),
      },
    };
  },
};
