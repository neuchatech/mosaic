import { resolve } from "node:path";
import { l2Normalize } from "./vector";
import type {
  ModelLoadProgress,
  VisualImageEncoder,
  VisualModelSpec,
} from "./types";

export const DEFAULT_CLIP_MODEL: VisualModelSpec = {
  id: "Xenova/clip-vit-base-patch32",
  revision: "main",
  dtype: "q8",
  expectedDimension: 512,
};

export type TransformersClipEncoderOptions = {
  model?: VisualModelSpec;
  modelCacheDir: string;
  allowModelDownload?: boolean;
  onModelProgress?: (progress: ModelLoadProgress) => void;
};

function disposeTensorValues(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("dispose" in value && typeof value.dispose === "function") {
    value.dispose();
    return;
  }
  if (Array.isArray(value)) value.forEach(disposeTensorValues);
}

export async function createTransformersClipEncoder(
  options: TransformersClipEncoderOptions,
): Promise<VisualImageEncoder> {
  const modelSpec = options.model ?? DEFAULT_CLIP_MODEL;
  const transformers = await import("@huggingface/transformers");
  const cacheDir = resolve(options.modelCacheDir);
  // Keep every model/config/processor artifact in MosAIc's ignored local cache.
  transformers.env.cacheDir = cacheDir;
  const localFilesOnly = !options.allowModelDownload;
  const progressCallback = (progress: { status?: string; file?: string; progress?: number }) => {
    options.onModelProgress?.({
      status: progress.status,
      file: progress.file,
      progress: progress.progress,
    });
  };
  const sharedOptions = {
    cache_dir: cacheDir,
    local_files_only: localFilesOnly,
    revision: modelSpec.revision,
    progress_callback: progressCallback,
  };

  const processor = await transformers.AutoProcessor.from_pretrained(modelSpec.id, sharedOptions);
  const model = await transformers.CLIPVisionModelWithProjection.from_pretrained(modelSpec.id, {
    ...sharedOptions,
    device: "cpu",
    dtype: modelSpec.dtype,
  });

  let closed = false;
  return {
    model: modelSpec,
    async encodeImage(imagePath: string): Promise<number[]> {
      if (closed) throw new Error("The CLIP image encoder is already closed.");
      const image = await transformers.RawImage.read(imagePath);
      const inputs = await processor(image);
      let output: Awaited<ReturnType<typeof model>> | undefined;
      try {
        output = await model(inputs);
        const embedding = output.image_embeds;
        const vector = Array.from(embedding.data as ArrayLike<number>, Number);
        if (modelSpec.expectedDimension && vector.length !== modelSpec.expectedDimension) {
          throw new Error(`CLIP returned ${vector.length} dimensions instead of ${modelSpec.expectedDimension}.`);
        }
        return l2Normalize(vector);
      } finally {
        Object.values(inputs as Record<string, unknown>).forEach(disposeTensorValues);
        if (output) Object.values(output as Record<string, unknown>).forEach(disposeTensorValues);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await model.dispose();
    },
  };
}
