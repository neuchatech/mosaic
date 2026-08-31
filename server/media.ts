import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicBytes } from "./public-html";
import { normalizePublicHttpsUrl } from "./public-network";

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

/** Read one regular media file after lexical and realpath containment checks. */
export async function readCatalogMedia(itemId: string, fileName: string, maxBytes?: number): Promise<Buffer> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error("Catalog media byte limit must be a positive integer.");
  }
  const path = catalogMediaPath(itemId, fileName);
  const fileInfo = await lstat(path);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Catalog media must be a regular app-owned file.");
  if (maxBytes !== undefined && fileInfo.size > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes.`);
  const [realRoot, realFile] = await Promise.all([realpath(mediaRoot), realpath(path)]);
  if (!realFile.startsWith(`${realRoot}${sep}`)) throw new Error("Invalid catalog media path.");
  return readFile(realFile);
}

/** Copies accepted image payloads or public HTTPS resources into app-owned storage. */
export async function persistCatalogImages(itemId: string, images: string[]): Promise<string[]> {
  const accepted = images.slice(0, 6);
  // Validate before creating anything: otherwise a hostile item id could make
  // mkdir escape data/media even though the later file write is rejected.
  const directory = dirname(catalogMediaPath(itemId, "1.jpg"));
  const stored: string[] = [];
  for (const [index, image] of accepted.entries()) {
    let buffer: Buffer;
    let extension: "jpg" | "png" | "webp";
    const existingMedia = /^\/api\/media\/([^/?#]+)\/([1-6]\.(?:jpg|png|webp))$/.exec(image);
    const publicImage = normalizePublicHttpsUrl(image);
    if (existingMedia) {
      let existingItemId: string;
      try {
        existingItemId = decodeURIComponent(existingMedia[1]!);
      } catch {
        throw new Error("Invalid catalog media URL.");
      }
      buffer = await readCatalogMedia(existingItemId, existingMedia[2]!, 12 * 1024 * 1024);
      extension = existingMedia[2]!.split(".").at(-1) as typeof extension;
    } else if (publicImage) {
      const response = await fetchPublicBytes(publicImage, {
        signal: AbortSignal.timeout(20_000),
        timeoutMs: 20_000,
        maxBytes: 12 * 1024 * 1024,
        accept: "image/webp,image/png,image/jpeg",
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Image fetch failed: ${response.status}`);
      const mediaType = response.contentType.toLocaleLowerCase().split(";", 1)[0]?.trim();
      const extensionForType: Record<string, typeof extension> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };
      const remoteExtension = mediaType ? extensionForType[mediaType] : undefined;
      if (!remoteExtension) throw new Error("Remote image must be JPEG, PNG, or WebP.");
      buffer = response.body;
      extension = remoteExtension;
    } else {
      const match = supportedImage.exec(image);
      if (!match) throw new Error("Unsupported image. Use a public HTTPS, app-owned, or base64 JPEG, PNG, or WebP image.");
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

/** Removes only one validated app-owned media directory. */
export async function deleteCatalogMedia(itemId: string): Promise<void> {
  if (!safeSegment.test(itemId)) throw new Error("Invalid catalog media path.");
  const directory = resolve(mediaRoot, itemId);
  if (!directory.startsWith(`${mediaRoot}${sep}`)) throw new Error("Invalid catalog media path.");
  await rm(directory, { recursive: true, force: true });
}
