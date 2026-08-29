import { isIP } from "node:net";
import { adapterFor } from "../collector/registry";
import { normalizeProduct } from "../collector/normalize";
import type { Product } from "../src/domain/catalog";
import { fetchPublicHtml } from "./public-html";
import type { CatalogRepository } from "./repository";

const blockedDomainSuffixes = [".local", ".localhost", ".internal", ".lan", ".home", ".test"];

export function isPublicShopHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLocaleLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || !hostname.includes(".")) return false;
  if (isIP(hostname)) return false;
  return !blockedDomainSuffixes.some((suffix) => hostname.endsWith(suffix));
}

function sameShopSite(requestedHostname: string, candidateHostname: string): boolean {
  const requested = requestedHostname.toLocaleLowerCase().replace(/\.$/, "");
  const candidate = candidateHostname.toLocaleLowerCase().replace(/\.$/, "");
  if (!isPublicShopHostname(candidate)) return false;
  return candidate === requested
    || candidate.endsWith(`.${requested}`)
    || requested.endsWith(`.${candidate}`);
}

export type PublicProductImportResult = {
  products: Product[];
  errors: Array<{ url: string; error: string }>;
};

export async function importPublicProductUrls(
  urls: string[],
  repository: CatalogRepository,
  signal: AbortSignal,
): Promise<PublicProductImportResult> {
  const uniqueUrls = [...new Set(urls)].slice(0, 12);
  const products: Product[] = [];
  const errors: PublicProductImportResult["errors"] = [];

  for (const input of uniqueUrls) {
    try {
      const requested = new URL(input);
      if (requested.protocol !== "https:" || !isPublicShopHostname(requested.hostname)) {
        throw new Error("Only public HTTPS shop pages can be imported.");
      }
      const response = await fetchPublicHtml(requested.href, {
        signal,
        allowedHost: (hostname) => sameShopSite(requested.hostname, hostname),
      });
      const current = new URL(response.url);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Product page returned HTTP ${response.status}.`);
      }
      if (!response.contentType.toLocaleLowerCase().includes("html")) {
        throw new Error(`Product page returned ${response.contentType || "an unknown content type"}.`);
      }
      const adapter = adapterFor(current, true);
      if (!adapter.extractDetailHtml) throw new Error("This shop needs a dedicated interactive reader.");
      const raw = await adapter.extractDetailHtml(response.html, current.href);
      if (!raw) throw new Error("No public Product JSON-LD was found on this page.");
      products.push(normalizeProduct(adapter.id, raw));
    } catch (error) {
      errors.push({ url: input, error: error instanceof Error ? error.message : "product import failed" });
    }
  }

  if (products.length) repository.upsertCollectedProducts(products);
  return { products, errors };
}
