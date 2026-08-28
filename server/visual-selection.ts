import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Product } from "../src/domain/catalog";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { codexExecutable } from "./codex-bridge";
import { CatalogRepository, type VisualJobRecord } from "./repository";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type VisualJobView = VisualJobRecord & {
  candidates: number;
  totalBatches: number;
  completedBatches: number;
  products: Product[];
};

function jobView(job: VisualJobRecord, repository: CatalogRepository): VisualJobView {
  const selected = repository.listVisualAssessments(job.id)
    .filter((assessment) => !assessment.rejected && assessment.score > job.threshold)
    .slice(0, job.targetCount)
    .map((assessment) => repository.getProduct(assessment.productId))
    .filter(Boolean) as Product[];
  const products = compactProjection(projectProducts(selected));
  return {
    ...job,
    candidates: job.maxInspections,
    totalBatches: job.maxInspections,
    completedBatches: job.inspected,
    products,
  };
}

function agentInstruction(job: VisualJobRecord): string {
  const visualWorkflow = job.analysisMode === "sheet"
    ? "Start with build_contact_sheet in small batches of at most 12 likely candidates. Use the sheet to compare them, then call inspect_product_image on any promising or ambiguous item when closer inspection would improve the score. Record every assessed shop product individually."
    : "Do not call build_contact_sheet. Inspect every candidate individually with inspect_product_image.";
  return [
    "You are the autonomous visual curator for the user's local Wardrobe Atlas.",
    `Visual job id: ${job.id}`,
    `User request: ${job.prompt}`,
    `Maximum shop products to inspect: ${job.maxInspections}`,
    `Desired number of strong results: ${job.targetCount}`,
    `Visibility threshold: score must be strictly greater than ${job.threshold}.`,
    `Analysis workflow: ${job.analysisMode === "sheet" ? "contact sheet plus optional detail inspection" : "sequential single-image inspection"}.`,
    "Use only the wardrobe_atlas MCP tools. Do not use shell, edit files, browse shops, or purchase anything.",
    visualWorkflow,
    job.referenceImages.length
      ? "The images attached to this initial request are the user's mood board. Treat them as the primary visual reference throughout the selection."
      : "No external mood board was attached; infer the visual target from the user's text and any saved catalog references.",
    "Act agentically: inspect catalog statistics, search the catalog with whatever queries or structured filters help, and adapt the next candidates based on what you learn.",
    "You may inspect saved reference images first as style anchors. Never score or record a reference: only record kind=shop products.",
    "For every shop candidate, call inspect_product_image with exactly one product id. Judge the actual garment in that returned image, not merely its name or metadata.",
    "Immediately after each image, call record_visual_assessment for that same product before inspecting another. Never batch several unseen products into one score call.",
    "Use a calibrated 0–1 score: 0.9–1 exceptional direct match, 0.7–0.89 strong, >0.5–0.69 useful, 0.3–0.5 weak, <0.3 contradiction. Set rejected=true only for a hard conflict, wrong garment/gender, sportswear contradiction, or unusable image.",
    "Evaluate silhouette, proportions, palette, fabric/texture, details, layering potential, and relationship to the user's request and references. Ignore model attractiveness, pose, photography, and brand prestige.",
    "Explore broadly enough to compare alternatives. Unless the catalog is exhausted, inspect at least 20 shop products; then stop when you have the desired number above threshold or reach the maximum. Never inspect or record the same product twice.",
    "Keep each reason concrete and under 30 words, with at most six short visual signals. Finish with a brief plain-text summary only after the sequential review is done.",
  ].join("\n\n");
}

async function runAgenticVisualJob(jobId: string, repository: CatalogRepository): Promise<void> {
  const job = repository.getVisualJob(jobId);
  if (!job) return;
  repository.updateVisualJob(jobId, {
    status: "planning",
    message: "Luna explore le catalogue et choisit sa première image…",
  });

  const args = [
    "exec",
    "--model", "gpt-5.6-luna",
    "--approve-for-me",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--config", "features.shell_tool=false",
    "--config", "model_reasoning_effort=\"medium\"",
    "--config", "mcp_servers.wardrobe_atlas.command=\"npm\"",
    "--config", "mcp_servers.wardrobe_atlas.args=[\"run\",\"mcp\"]",
    "--config", `mcp_servers.wardrobe_atlas.cwd=${JSON.stringify(projectRoot)}`,
    "--config", "mcp_servers.wardrobe_atlas.startup_timeout_sec=20",
    "--config", "mcp_servers.wardrobe_atlas.tool_timeout_sec=120",
  ];
  for (const image of job.referenceImages) args.push("--image", image);
  args.push("-");

  await new Promise<void>((resolvePromise) => {
    const logsRoot = resolve(projectRoot, "data/codex-jobs");
    mkdirSync(logsRoot, { recursive: true });
    const eventLog = createWriteStream(resolve(logsRoot, `${jobId}-agent.jsonl`), { flags: "a" });
    const child = spawn(codexExecutable(), args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish("Codex agent timed out after 30 minutes.");
    }, 30 * 60 * 1000);
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const current = repository.getVisualJob(jobId);
      if (!current) return resolvePromise();
      if (error) {
        repository.updateVisualJob(jobId, {
          status: "error",
          message: "L’analyse agentique s’est interrompue.",
          error,
        });
      } else if (current.inspected === 0) {
        repository.updateVisualJob(jobId, {
          status: "error",
          message: "Luna n’a enregistré aucune évaluation.",
          error: `The Codex agent completed without calling record_visual_assessment. ${diagnostics}`.slice(-6000),
        });
      } else {
        repository.updateVisualJob(jobId, {
          status: "complete",
          message: `${current.selected} articles au-dessus de ${current.threshold.toFixed(2)} après ${current.inspected} images.`,
          error: null,
        });
      }
      eventLog.end();
      resolvePromise();
    };

    child.stdout.on("data", (chunk) => {
      eventLog.write(chunk);
      diagnostics = `${diagnostics}${String(chunk)}`.slice(-16_000);
    });
    child.stderr.on("data", (chunk) => {
      eventLog.write(chunk);
      diagnostics = `${diagnostics}${String(chunk)}`.slice(-16_000);
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code) => finish(code === 0 ? undefined : `Codex exited with code ${code}: ${diagnostics}`));
    child.stdin.end(agentInstruction(job));
  });
}

export type VisualPromptImage = { name?: string; dataUrl: string };

async function persistReferenceImages(jobId: string, images: VisualPromptImage[]): Promise<string[]> {
  const accepted = images.slice(0, 6);
  if (accepted.length === 0) return [];
  const directory = resolve(projectRoot, "data/codex-jobs", jobId, "references");
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const [index, image] of accepted.entries()) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl);
    if (!match) throw new Error("Unsupported mood-board image. Use JPEG, PNG, or WebP.");
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.byteLength > 12 * 1024 * 1024) throw new Error("Each mood-board image must be smaller than 12 MB.");
    const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice("image/".length);
    const path = resolve(directory, `${index + 1}.${extension}`);
    await writeFile(path, buffer);
    paths.push(path);
  }
  return paths;
}

export async function startVisualSelection(input: {
  prompt: string;
  maxCandidates?: number;
  topN?: number;
  threshold?: number;
  analysisMode?: "sequential" | "sheet";
  images?: VisualPromptImage[];
}, repository: CatalogRepository): Promise<VisualJobView> {
  const maxInspections = Math.min(Math.max(input.maxCandidates ?? 48, 4), 160);
  const targetCount = Math.min(Math.max(input.topN ?? 24, 1), maxInspections);
  const threshold = Math.min(.95, Math.max(.05, input.threshold ?? .5));
  const id = crypto.randomUUID();
  const referenceImages = await persistReferenceImages(id, input.images ?? []);
  const job = repository.createVisualJob({
    id,
    prompt: input.prompt,
    maxInspections,
    targetCount,
    threshold,
    analysisMode: input.analysisMode === "sheet" ? "sheet" : "sequential",
    referenceImages,
  });
  void runAgenticVisualJob(job.id, repository);
  return jobView(job, repository);
}

export function getVisualSelection(id: string, repository: CatalogRepository): VisualJobView | null {
  const job = repository.getVisualJob(id);
  return job ? jobView(job, repository) : null;
}
