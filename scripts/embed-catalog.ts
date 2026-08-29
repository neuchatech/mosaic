import { resolve } from "node:path";
import { Command } from "commander";
import { CatalogRepository } from "../server/repository";
import { embedCatalogProducts } from "../server/visual-embeddings";
import { writeVisualEmbeddingArtifact, type VisualEmbeddingProgress } from "../src/embeddings";

const program = new Command();
program
  .name("embed-catalog")
  .description("Build a local incremental CLIP + metadata embedding artifact for Wardrobe Atlas.")
  .option("--limit <count>", "Maximum catalog items", "10000")
  .option("--images-per-item <count>", "Average up to N product images (1-5)", "1")
  .option("--cache-dir <path>", "Image and embedding cache", "data/image-cache/visual-embeddings")
  .option("--model-cache-dir <path>", "Transformers.js model cache", "data/image-cache/transformers")
  .option("--output <path>", "Hybrid vector artifact", "data/image-cache/visual-embeddings.json")
  .option("--download-model", "Allow the one-time Hugging Face model download", false)
  .option("--force", "Refresh images and recompute embeddings", false)
  .option("--visual-weight <number>", "Visual block weight", "0.68")
  .option("--metadata-weight <number>", "Metadata block weight", "0.32")
  .parse();

const options = program.opts<{
  limit: string;
  imagesPerItem: string;
  cacheDir: string;
  modelCacheDir: string;
  output: string;
  downloadModel: boolean;
  force: boolean;
  visualWeight: string;
  metadataWeight: string;
}>();

function boundedInteger(value: string, minimum: number, maximum: number, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function weight(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number.`);
  return number;
}

const limit = boundedInteger(options.limit, 1, 10_000, "--limit");
const imagesPerItem = boundedInteger(options.imagesPerItem, 1, 5, "--images-per-item");
const weights = {
  visual: weight(options.visualWeight, "--visual-weight"),
  metadata: weight(options.metadataWeight, "--metadata-weight"),
};
if (weights.visual + weights.metadata === 0) throw new Error("At least one hybrid weight must be positive.");

const repository = new CatalogRepository();
const products = repository.listProducts({ limit });
const controller = new AbortController();
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  controller.abort(new Error("Interrupted by SIGINT."));
  process.stderr.write("\nStopping after the current local cache operation…\n");
});

let lastPrinted = -1;
function progress(event: VisualEmbeddingProgress): void {
  if (event.phase === "model-loading") {
    if (event.modelFile && event.modelProgress !== undefined) {
      const percent = Math.round(event.modelProgress);
      if (percent !== lastPrinted) {
        lastPrinted = percent;
        process.stdout.write(`\rModel ${event.modelFile}: ${percent}%   `);
      }
    }
    return;
  }
  if (event.phase === "model-ready" || event.phase === "model-unavailable") {
    process.stdout.write(`\n${event.message ?? event.phase}\n`);
    return;
  }
  if (event.phase === "item-error") {
    process.stderr.write(`\n${event.itemId}: ${event.message ?? "visual fallback"}\n`);
    return;
  }
  if (event.phase === "item-complete" && (event.processed % 10 === 0 || event.processed === event.total)) {
    process.stdout.write(`\rEmbedded/indexed ${event.processed}/${event.total}   `);
  }
}

console.log(`Indexing ${products.length} catalog items locally (${options.downloadModel ? "model download allowed" : "offline model mode"}).`);
const run = await embedCatalogProducts(products, {
  cacheDir: resolve(options.cacheDir),
  modelCacheDir: resolve(options.modelCacheDir),
  allowModelDownload: options.downloadModel,
  imagesPerItem,
  force: options.force,
  weights,
  signal: controller.signal,
  onProgress: progress,
});
await writeVisualEmbeddingArtifact(resolve(options.output), run);
process.stdout.write("\n");
console.log(JSON.stringify({ output: resolve(options.output), ...run.summary }, null, 2));
if (interrupted) process.exitCode = 130;
