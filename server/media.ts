import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediaRoot = resolve(projectRoot, "data/media");
const supportedImage = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const safeSegment = /^[A-Za-z0-9._-]+$/;

export function catalogMediaPath(itemId: string, fileName: string): string {
  if (!safeSegment.test(itemId) || !/^[1-6]\.(?:jpg|png|webp)$/.test(fileName)) throw new Error("Invalid catalog media path.");
  const path = resolve(mediaRoot, itemId, fileName);
  if (!path.startsWith(`${mediaRoot}${sep}`)) throw new Error("Invalid catalog media path.");
  return path;
}

export function catalogMediaType(fileName: string): string {
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/** Copies user-supplied local images out of request payloads and into app-owned storage. */
export async function persistCatalogImages(itemId: string, images: string[]): Promise<string[]> {
  const accepted = images.slice(0, 6);
  const directory = resolve(mediaRoot, itemId);
  const stored: string[] = [];
  for (const [index, image] of accepted.entries()) {
    if (/^https?:\/\//i.test(image) || image.startsWith("/")) {
      stored.push(image);
      continue;
    }
    let buffer: Buffer;
    let extension: "jpg" | "png" | "webp";
    if (image.startsWith("file://")) {
      const file = new URL(image);
      const suffix = extname(file.pathname).toLocaleLowerCase();
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(suffix)) throw new Error("Unsupported image. Use JPEG, PNG, or WebP.");
      buffer = await readFile(file);
      extension = suffix === ".jpeg" ? "jpg" : suffix.slice(1) as typeof extension;
    } else {
      const match = supportedImage.exec(image);
      if (!match) throw new Error("Unsupported image. Use JPEG, PNG, or WebP.");
      buffer = Buffer.from(match[2], "base64");
      extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice("image/".length) as typeof extension;
    }
    if (buffer.byteLength > 12 * 1024 * 1024) throw new Error("Each image must be smaller than 12 MB.");
    await mkdir(directory, { recursive: true });
    const fileName = `${index + 1}.${extension}`;
    const path = catalogMediaPath(itemId, fileName);
    await writeFile(path, buffer);
    stored.push(`/api/media/${encodeURIComponent(itemId)}/${fileName}`);
  }
  return stored;
}
