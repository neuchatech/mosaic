import type { ShopAdapter } from "../types";

const SIZE_PATTERN = /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|(?:EU\s*)?\d{2,3}(?:[.,]5)?|\d{1,2}\s*[/-]\s*\d{1,2})$/i;

export function normalizeZalandoSizes(values: string[]): string[] {
  const cleaned = values.flatMap((value) => value
    .split(/[\n,;|]/)
    .map((part) => part
      .replace(/^(?:taille|size|grösse)\s*:?\s*/i, "")
      .replace(/\s+(?:disponible|available|verfügbar)$/i, "")
      .trim())
    .filter((part) => SIZE_PATTERN.test(part))
    .map((part) => part.toUpperCase().replace(/\s+/g, " ").replace(",", ".")));
  return [...new Set(cleaned)];
}

function priceFromText(text: string): number | null {
  const match = text.match(/(?:CHF|Fr\.?)[\s\u00a0]*([0-9'’.,]+)/i);
  if (!match) return null;
  return Number(match[1].replace(/[’']/g, "").replace(",", "."));
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
        const link = article.querySelector<HTMLAnchorElement>('a[href*=".html"]');
        const image = article.querySelector<HTMLImageElement>("img");
        const text = (article.textContent ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
        if (!link || text.length === 0) return [];
        return [{
          url: link.href,
          image: image?.currentSrc || image?.src || "",
          alt: image?.alt || "",
          text,
        }];
      }),
    );

    return cards.map((card) => {
      const useful = card.text.filter((line) => !/^(nouveau|promo|exclusivité|plus durable)$/i.test(line));
      const priceLine = useful.find((line) => /CHF|Fr\.?/i.test(line)) ?? "";
      const price = priceFromText(priceLine);
      const sourceId = new URL(card.url).pathname.split("/").pop()?.replace(/\.html$/, "");
      return {
        sourceId,
        url: card.url,
        brand: useful[0] ?? "Unknown",
        name: useful[1] ?? card.alt ?? useful[0] ?? "Article Zalando",
        price,
        currency: "CHF",
        images: card.image ? [card.image] : [],
        attributes: { listingText: useful.slice(0, 12) },
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
      const sizeCandidates: string[] = [];
      const addSize = (value: unknown) => {
        if (typeof value === "string") sizeCandidates.push(value);
        if (Array.isArray(value)) value.forEach(addSize);
      };
      addSize(product.size);
      for (const candidateOffer of offers) {
        if (String(candidateOffer?.availability ?? "").toLowerCase().includes("outofstock")) continue;
        addSize(candidateOffer?.size);
        addSize(candidateOffer?.itemOffered?.size);
        for (const property of candidateOffer?.itemOffered?.additionalProperty ?? []) {
          if (/size|taille|grösse/i.test(String(property?.name ?? ""))) addSize(property?.value);
        }
      }
      const sizeSelectors = [
        '[data-testid*="size" i] button:not([disabled]):not([aria-disabled="true"])',
        '[data-testid*="size" i] option:not([disabled])',
        'select[name*="size" i] option:not([disabled])',
        'select[aria-label*="taille" i] option:not([disabled])',
        'select[aria-label*="size" i] option:not([disabled])',
      ];
      for (const element of document.querySelectorAll<HTMLElement>(sizeSelectors.join(","))) {
        addSize(element.getAttribute("value"));
        addSize(element.getAttribute("aria-label"));
        addSize(element.textContent);
      }
      return {
        sourceId: String(product.sku ?? product.productID ?? ""),
        url: location.href,
        brand: typeof product.brand === "string" ? product.brand : product.brand?.name,
        name: product.name,
        description: product.description,
        color: product.color,
        material: product.material,
        images: Array.isArray(product.image) ? product.image : product.image ? [product.image] : [],
        price: Number(offer?.price),
        currency: offer?.priceCurrency,
        available: !String(offer?.availability ?? "").toLowerCase().includes("outofstock"),
        sizeCandidates,
      };
    });
    if (!raw?.name) return null;
    const sizes = normalizeZalandoSizes(raw.sizeCandidates);
    return {
      ...raw,
      sizes,
      materials: raw.material ? [String(raw.material)] : [],
      colorFamily: raw.color ?? "unknown",
      attributes: { detailCaptured: true, sizeAvailabilityKnown: sizes.length > 0 || !raw.available },
    };
  },
};
