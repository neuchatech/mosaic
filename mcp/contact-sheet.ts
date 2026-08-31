import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharpFactory from "sharp";
import { readCatalogMedia } from "../server/media";
import { fetchPublicBytes } from "../server/public-html";
import { normalizePublicHttpsUrl } from "../server/public-network";
import type { Product } from "../src/domain/catalog";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type SharpPipeline = {
  rotate(): SharpPipeline;
  resize(width: number, height: number, options: { fit: "cover" | "inside"; withoutEnlargement?: boolean }): SharpPipeline;
  jpeg(options?: { quality: number }): SharpPipeline;
  composite(items: { input: Buffer; top: number; left: number }[]): SharpPipeline;
  toBuffer(): Promise<Buffer>;
};
type SharpFactory = (input: Buffer | string | {
  create: { width: number; height: number; channels: 3; background: string };
}) => SharpPipeline;
const sharp = sharpFactory as unknown as SharpFactory;
const imageLoads = new Map<string, Promise<Buffer>>();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[character] ?? character);
}

export async function loadProductImage(product: Product): Promise<Buffer> {
  const source = product.images[0];
  if (!source) {
    return sharp({ create: { width: 240, height: 270, channels: 3, background: "#ded9cf" } }).jpeg().toBuffer();
  }
  if (product.kind !== "shop") {
    // User images are copied to app-owned storage at ingestion. Contact sheets
    // never follow an arbitrary local path, even when a catalog row is edited
    // or imported outside the normal API.
    const mediaUrl = /^\/api\/media\/([^/?#]+)\/([1-6]\.(?:jpg|png|webp))$/.exec(source);
    if (!mediaUrl) throw new Error("Owned and reference images must use app-owned catalog media.");
    let itemId: string;
    try {
      itemId = decodeURIComponent(mediaUrl[1]!);
    } catch {
      throw new Error("Invalid catalog media URL.");
    }
    if (itemId !== product.id) throw new Error("Catalog media does not belong to this item.");
    return readCatalogMedia(itemId, mediaUrl[2]!, 20 * 1024 * 1024);
  }

  const safeSource = normalizePublicHttpsUrl(source);
  if (!safeSource) throw new Error("Shop images must use a public HTTPS URL.");
  const existingLoad = imageLoads.get(safeSource);
  if (existingLoad) return existingLoad;
  const load = (async () => {
    const directory = resolve(projectRoot, "data/image-cache");
    // A namespace bump prevents data fetched by the former unrestricted loader
    // (including file: and HTTP targets) from being treated as trusted cache.
    const path = resolve(directory, `public-v1-${hash(safeSource)}.img`);
    try {
      return await readFile(path);
    } catch {
      const response = await fetchPublicBytes(safeSource, {
        signal: AbortSignal.timeout(12_000),
        timeoutMs: 12_000,
        maxBytes: 20 * 1024 * 1024,
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Image fetch failed: ${response.status}`);
      const contentType = response.contentType.toLocaleLowerCase().split(";", 1)[0]?.trim();
      if (!contentType?.startsWith("image/") && contentType !== "application/octet-stream") {
        throw new Error(`Image fetch returned ${response.contentType || "an unknown content type"}.`);
      }
      await mkdir(directory, { recursive: true });
      await writeFile(path, response.body);
      return response.body;
    }
  })();
  imageLoads.set(safeSource, load);
  try {
    return await load;
  } finally {
    imageLoads.delete(safeSource);
  }
}

async function tile(product: Product, index: number): Promise<Buffer> {
  let image: Buffer;
  try {
    image = await sharp(await loadProductImage(product)).rotate().resize(240, 270, { fit: "cover" }).jpeg({ quality: 78 }).toBuffer();
  } catch {
    image = await sharp({ create: { width: 240, height: 270, channels: 3, background: "#d7d1c5" } }).jpeg().toBuffer();
  }
  const label = Buffer.from(`
    <svg width="240" height="70" xmlns="http://www.w3.org/2000/svg">
      <rect width="240" height="70" fill="#fbfaf6"/>
      <text x="9" y="17" font-family="Arial" font-size="11" font-weight="700" fill="#28231d">${index + 1} · ${escapeXml(product.brand)}</text>
      <text x="9" y="35" font-family="Arial" font-size="11" fill="#28231d">${escapeXml(product.name.slice(0, 34))}</text>
      <text x="9" y="54" font-family="Arial" font-size="9" fill="#766e63">${escapeXml(product.id)} · ${product.price === null ? "référence" : `${product.price} ${product.currency}`}</text>
    </svg>
  `);
  return sharp({ create: { width: 240, height: 340, channels: 3, background: "#fbfaf6" } })
    .composite([{ input: image, top: 0, left: 0 }, { input: label, top: 270, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

export async function buildProductPreview(product: Product): Promise<Buffer> {
  return sharp(await loadProductImage(product))
    .rotate()
    .resize(900, 1100, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
}

export async function buildContactSheet(products: Product[]): Promise<{ buffer: Buffer; path: string }> {
  const columns = Math.min(4, Math.max(products.length, 1));
  const rows = Math.ceil(Math.max(products.length, 1) / columns);
  const directory = resolve(projectRoot, "data/contact-sheets");
  await mkdir(directory, { recursive: true });
  const signature = products.map((product) => `${product.id}:${product.images[0] ?? ""}`).join("|");
  const path = resolve(directory, `sheet-${hash(`${columns}x${rows}:${signature}`).slice(0, 20)}.jpg`);
  try {
    return { buffer: await readFile(path), path };
  } catch {
    // Cache miss: render below.
  }
  const tiles = await Promise.all(products.map(tile));
  const buffer = await sharp({
    create: { width: columns * 240, height: rows * 340, channels: 3, background: "#eeeae1" },
  }).composite(tiles.map((input, index) => ({
    input,
    left: (index % columns) * 240,
    top: Math.floor(index / columns) * 340,
  }))).jpeg({ quality: 84 }).toBuffer();

  await writeFile(path, buffer);
  return { buffer, path };
}
