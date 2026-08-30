import { adapterFor } from "../collector/registry";
import { normalizeProduct } from "../collector/normalize";
import type { Product } from "../src/domain/catalog";
import { fetchPublicHtml } from "./public-html";
import { isPublicShopHostname, normalizePublicHttpsUrl } from "./public-network";
import type { CatalogRepository } from "./repository";

export { isPublicShopHostname };

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
  options: { workspaceId?: string } = {},
): Promise<PublicProductImportResult> {
  const workspaceId = options.workspaceId ?? "default-clothing";
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
      // Adapters may consume third-party JSON-LD or browser-extracted markup.
      // Resolve relative gallery URLs against the final page and never persist
      // a local, clear-text, credentialed, or IP-literal image target.
      const safeRaw = {
        ...raw,
        url: (() => {
          const candidate = normalizePublicHttpsUrl(raw.url ?? current.href, current);
          if (!candidate) return current.href;
          return sameShopSite(current.hostname, new URL(candidate).hostname) ? candidate : current.href;
        })(),
        images: [...new Set((raw.images ?? []).flatMap((image) => {
          const safeUrl = normalizePublicHttpsUrl(image, current);
          return safeUrl ? [safeUrl] : [];
        }))],
      };
      const normalized = normalizeProduct(adapter.id, safeRaw, workspaceId);
      const workspace = repository.getWorkspace(workspaceId);
      products.push({
        ...normalized,
        // The legacy normalizer intentionally collapses retailer taxonomies to
        // clothing facets. Generic workspaces keep the public product taxonomy
        // and facts instead of turning TVs, furniture, etc. into “Autre”.
        ...(workspace && workspace.profile !== "clothing" ? {
          category: safeRaw.category ?? "Other",
          color: safeRaw.color ?? "Unknown",
          colorFamily: safeRaw.colorFamily ?? "unknown",
          fit: safeRaw.fit ?? "not_applicable",
          tags: safeRaw.tags ?? [],
        } : {}),
      });
    } catch (error) {
      errors.push({ url: input, error: error instanceof Error ? error.message : "product import failed" });
    }
  }

  if (products.length) repository.upsertCollectedProducts(products);
  // Re-read after the collector-safe merge so callers see preserved decisions,
  // annotations and the authoritative workspace association.
  return {
    products: products.map((product) => repository.getProduct(product.id, workspaceId) ?? product),
    errors,
  };
}
