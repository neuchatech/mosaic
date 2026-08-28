import type { ShopAdapter } from "../types";

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
        const text = (anchor.textContent ?? image?.alt ?? "").trim();
        if (!text || !image) return [];
        return [{ url: anchor.href, name: text, image: image.currentSrc || image.src }];
      }));
      return links.map((link) => ({ name: link.name, url: link.url, images: [link.image] }));
    },
    async extractDetail(page) {
      return page.evaluate(() => {
        const values = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).flatMap((script) => {
          try {
            const parsed = JSON.parse(script.textContent ?? "null");
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return [];
          }
        });
        const product = values.find((value) => value?.["@type"] === "Product");
        if (!product?.name) return null;
        const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
        return {
          sourceId: String(product.sku ?? product.productID ?? ""),
          url: location.href,
          brand: typeof product.brand === "string" ? product.brand : product.brand?.name,
          name: product.name,
          description: product.description,
          price: Number.isFinite(Number(offer?.price)) ? Number(offer.price) : null,
          currency: offer?.priceCurrency,
          color: product.color,
          materials: product.material ? [String(product.material)] : [],
          images: Array.isArray(product.image) ? product.image : product.image ? [product.image] : [],
        };
      });
    },
  };
}
