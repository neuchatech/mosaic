import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CatalogRepository } from "./repository";
import { clearProjectionCache, projectCompactCached } from "./projection-cache";
import { embedCatalogProducts } from "./visual-embeddings";
import {
  writeVisualEmbeddingArtifact,
  type VisualEmbeddingProgress,
  type VisualEmbeddingRun,
} from "../src/embeddings";

export type EmbeddingJobView = {
  status: "idle" | "running" | "succeeded" | "failed";
  processed: number;
  total: number;
  phase?: VisualEmbeddingProgress["phase"];
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: { embedded: number; metadataOnly: number; cacheHits: number; errors: number };
};

const artifactPath = resolve("data/image-cache/visual-embeddings.json");

function persistedJobView(): EmbeddingJobView {
  try {
    const run = JSON.parse(readFileSync(artifactPath, "utf8")) as VisualEmbeddingRun;
    const finishedAt = run.summary.finishedAt ?? statSync(artifactPath).mtime.toISOString();
    return {
      status: "succeeded",
      processed: run.summary.processed,
      total: run.summary.total,
      finishedAt,
      message: run.summary.modelAvailable
        ? "Projection visuelle prête."
        : "Projection métadonnées prête; CLIP indisponible.",
      summary: {
        embedded: run.summary.embedded,
        metadataOnly: run.summary.metadataOnly,
        cacheHits: run.summary.cacheHits,
        errors: run.summary.errors,
      },
    };
  } catch {
    return { status: "idle", processed: 0, total: 0 };
  }
}

let current: EmbeddingJobView = persistedJobView();
let rerunRequested = false;

export function getEmbeddingJob(): EmbeddingJobView {
  return { ...current, summary: current.summary ? { ...current.summary } : undefined };
}

export function startEmbeddingJob(repository: CatalogRepository): EmbeddingJobView {
  if (current.status === "running") {
    rerunRequested = true;
    return getEmbeddingJob();
  }
  const products = repository.listProducts({ limit: 10_000 });
  current = {
    status: "running",
    processed: 0,
    total: products.length,
    startedAt: new Date().toISOString(),
    message: "Chargement de CLIP local…",
  };
  void (async () => {
    try {
      const run = await embedCatalogProducts(products, {
        allowModelDownload: true,
        imagesPerItem: 1,
        onProgress(progress) {
          current = {
            ...current,
            phase: progress.phase,
            processed: progress.processed,
            total: progress.total,
            message: progress.message,
          };
        },
      });
      await writeVisualEmbeddingArtifact(artifactPath, run);
      clearProjectionCache();
      // Persist coordinates per workspace. Mixing unrelated domains (for
      // example clothing and televisions) would distort the stored fallback
      // coordinates even though each board is projected independently.
      for (const workspace of repository.listWorkspaces()) {
        repository.replaceCoordinates(projectCompactCached(repository.listProducts({
          workspaceId: workspace.id,
          limit: 10_000,
        })));
      }
      current = {
        ...current,
        status: "succeeded",
        processed: run.summary.processed,
        total: run.summary.total,
        finishedAt: new Date().toISOString(),
        message: run.summary.modelAvailable ? "Projection visuelle prête." : "Projection métadonnées prête; CLIP indisponible.",
        summary: {
          embedded: run.summary.embedded,
          metadataOnly: run.summary.metadataOnly,
          cacheHits: run.summary.cacheHits,
          errors: run.summary.errors,
        },
      };
    } catch (error) {
      current = {
        ...current,
        status: "failed",
        finishedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "CLIP indexing failed",
      };
    } finally {
      if (rerunRequested) {
        rerunRequested = false;
        queueMicrotask(() => startEmbeddingJob(repository));
      }
    }
  })();
  return getEmbeddingJob();
}
