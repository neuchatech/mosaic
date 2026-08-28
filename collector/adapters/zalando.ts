import type { ShopAdapter } from "../types";

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
      const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
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
      };
    });
    if (!raw?.name) return null;
    return {
      ...raw,
      materials: raw.material ? [String(raw.material)] : [],
      colorFamily: raw.color ?? "unknown",
      attributes: { detailCaptured: true },
    };
  },
};
