import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharpFactory from "sharp";
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
  if (source.startsWith("/")) return readFile(resolve(projectRoot, "public", source.slice(1)));
  if (source.startsWith("file://")) return readFile(new URL(source));
  const response = await fetch(source, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
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
  const tiles = await Promise.all(products.map(tile));
  const buffer = await sharp({
    create: { width: columns * 240, height: rows * 340, channels: 3, background: "#eeeae1" },
  }).composite(tiles.map((input, index) => ({
    input,
    left: (index % columns) * 240,
    top: Math.floor(index / columns) * 340,
  }))).jpeg({ quality: 84 }).toBuffer();

  const directory = resolve(projectRoot, "data/contact-sheets");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `sheet-${Date.now()}.jpg`);
  await writeFile(path, buffer);
  return { buffer, path };
}
