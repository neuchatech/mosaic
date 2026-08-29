import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharpModule from "sharp";
import type { Product } from "../src/domain/catalog";

const artifactPath = resolve("data/image-cache/visual-embeddings.json");
const imageDirectory = resolve("data/image-cache/visual-embeddings/images");

type EmbeddingArtifact = {
  results?: Array<{ itemId?: string; contentHashes?: string[] }>;
};

let cachedMtime = -1;
let cachedRatios = new Map<string, number>();
let loading: Promise<Map<string, number>> | null = null;
const readImage = sharpModule as unknown as (path: string) => { metadata(): Promise<{ width?: number; height?: number }> };

async function loadRatios(): Promise<Map<string, number>> {
  try {
    const mtime = (await stat(artifactPath)).mtimeMs;
    if (mtime === cachedMtime) return cachedRatios;
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as EmbeddingArtifact;
    const rows = (artifact.results ?? []).filter((row) => row.itemId && row.contentHashes?.[0]);
    const ratios = new Map<string, number>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(16, rows.length) }, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const metadata = await readImage(resolve(imageDirectory, `${row.contentHashes![0]}.img`)).metadata();
          if (!metadata.width || !metadata.height) continue;
          ratios.set(row.itemId!, Math.min(3, Math.max(.25, metadata.width / metadata.height)));
        } catch {
          // A missing or corrupt cached image simply keeps the client fallback.
        }
      }
    });
    await Promise.all(workers);
    cachedMtime = mtime;
    cachedRatios = ratios;
    return ratios;
  } catch {
    return cachedRatios;
  }
}

export async function attachImageAspectRatios(products: Product[]): Promise<Product[]> {
  if (!loading) loading = loadRatios().finally(() => { loading = null; });
  const ratios = await loading;
  return products.map((product) => {
    const imageAspectRatio = ratios.get(product.id);
    if (!imageAspectRatio) return product;
    return { ...product, attributes: { ...product.attributes, imageAspectRatio } };
  });
}
