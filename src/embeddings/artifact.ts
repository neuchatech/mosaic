import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  VISUAL_EMBEDDING_SCHEMA_VERSION,
  type VisualEmbeddingRun,
} from "./types";

export async function writeVisualEmbeddingArtifact(path: string, run: VisualEmbeddingRun): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run)}\n`);
  await rename(temporary, path);
}

export async function readVisualEmbeddingArtifact(path: string): Promise<VisualEmbeddingRun | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<VisualEmbeddingRun>;
    if (value.schemaVersion !== VISUAL_EMBEDDING_SCHEMA_VERSION) return null;
    if (!value.model || !Array.isArray(value.results) || !value.summary) return null;
    return value as VisualEmbeddingRun;
  } catch {
    return null;
  }
}

export function hybridVectorsByItem(run: VisualEmbeddingRun): Map<string, number[]> {
  return new Map(run.results.map((result) => [result.itemId, result.hybridVector]));
}

export function visualVectorsByItem(run: VisualEmbeddingRun): Map<string, number[]> {
  return new Map(run.results.flatMap((result) => result.visualVector
    ? [[result.itemId, result.visualVector] as const]
    : []));
}
