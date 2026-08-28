import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filterSpecSchema, type FilterSpec } from "../src/domain/catalog";
import { CatalogRepository } from "./repository";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function codexExecutable(): string {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (process.platform === "darwin" && existsSync(bundledCodex)) return bundledCodex;
  return "codex";
}

export async function runCodexStructured(options: {
  instruction: string;
  schemaPath: string;
  outputPath: string;
  images?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const args = [
    "exec",
    "--model", "gpt-5.6-luna",
    "--sandbox", "read-only",
    "--ephemeral",
    "--output-schema", options.schemaPath,
    "--output-last-message", options.outputPath,
    "--config", "approval_policy=\"never\"",
    "--config", "features.shell_tool=false",
    "--config", "model_reasoning_effort=\"low\"",
  ];
  for (const image of options.images ?? []) args.push("--image", image);
  args.push("-");

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(codexExecutable(), args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex generation timed out after ${Math.round((options.timeoutMs ?? 180_000) / 1000)} seconds.`));
    }, options.timeoutMs ?? 180_000);

    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${String(chunk)}`.slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with code ${code}: ${errorOutput}`));
    });
    child.stdin.end(options.instruction);
  });
}

export type CodexFilterResult = {
  filter: FilterSpec;
  model: "gpt-5.6-luna";
  jobId: string;
};

export type CodexNode = {
  type: "clause" | "group" | "not";
  conjunction: "and" | "or" | "none";
  field: string;
  operator: "eq" | "neq" | "contains" | "not_contains" | "in" | "not_in" | "gte" | "lte" | "between" | "exists" | "missing" | "none";
  valueKind: "string" | "number" | "boolean" | "strings" | "numbers" | "null" | "none";
  stringValues: string[];
  numberValues: number[];
  booleanValue: boolean;
  children: CodexNode[];
};

type CodexOutput = {
  name: string;
  description: string;
  root: CodexNode;
  sortField: string;
  sortDirection: "asc" | "desc";
  limit: number;
};

export function convertCodexNode(node: CodexNode): FilterSpec["where"] | null {
  if (node.type === "group") {
    const children = node.children
      .map(convertCodexNode)
      .filter((child): child is FilterSpec["where"] => child !== null);
    return {
      type: "group",
      conjunction: node.conjunction === "or" ? "or" : "and",
      children,
    };
  }
  if (node.type === "not") {
    const child = node.children[0] ? convertCodexNode(node.children[0]) : null;
    return child ? { type: "not", child } : null;
  }
  if (!node.field.trim() || node.operator === "none") return null;
  const value = node.valueKind === "string" ? node.stringValues[0]
    : node.valueKind === "number" ? node.numberValues[0]
      : node.valueKind === "boolean" ? node.booleanValue
        : node.valueKind === "strings" ? node.stringValues
          : node.valueKind === "numbers" ? node.numberValues
            : node.valueKind === "null" ? null : undefined;
  return {
    type: "clause",
    field: node.field,
    operator: node.operator,
    ...(value === undefined ? {} : { value }),
  };
}

export async function createFilterWithCodex(
  userPrompt: string,
  repository = new CatalogRepository(),
): Promise<CodexFilterResult> {
  if (!userPrompt.trim()) throw new Error("Filter prompt is empty.");
  const jobId = crypto.randomUUID();
  const jobsRoot = resolve(projectRoot, "data/codex-jobs");
  const outputPath = resolve(jobsRoot, `${jobId}.json`);
  await mkdir(jobsRoot, { recursive: true });

  const catalogStats = repository.stats();
  const instruction = [
    "Translate the French wardrobe request below into one Wardrobe Atlas FilterSpec.",
    "Return only the structured object required by the supplied output schema.",
    "Every expression node uses the same shape. For unused fields, use conjunction=none, operator=none, valueKind=none, empty value arrays, booleanValue=false, and empty children.",
    "A not node contains exactly one child. A group uses conjunction and children. A clause uses field, operator, valueKind, and the matching value array or boolean.",
    "Never add placeholder, padding, or no-op nodes to a group's children array.",
    "Use sortField='' when no explicit sort was requested.",
    "Do not call tools and do not edit files.",
    "Fields can be any Product path: kind, source, brand, name, description, price, originalPrice, discountPercent, currency, category, color, colorFamily, fit, materials, tags, sizes, available, decision, importedAt, updatedAt, scores.<name>, attributes.<name>.",
    "Canonical catalog values: category is Vestes, Pantalons, Mailles, Chemises, or T-shirts; colorFamily is brown, beige, green, blue, neutral, or unknown; fit is large, courte, droite, slim, or unknown.",
    "For precise shades such as olive, tobacco, or chocolate, query color with contains; broad olive intent can also match colorFamily=green. Interpret boxy, loose, wide, relaxed, and oversized as fit=large; cropped and short as fit=courte.",
    "Product names and descriptions are mostly English or German. Translate French search concepts into likely catalog tokens and OR them when useful, for example rayures→stripe/striped, carreaux→check/checked/plaid, velours côtelé→corduroy, and maille→knit/jumper.",
    "Use nested and/or/not expressions for complex logic. Use case-insensitive contains for fuzzy textual intent.",
    "References have kind=reference and shop articles have kind=shop. Missing information must not be invented.",
    `Current catalog summary: ${JSON.stringify(catalogStats)}`,
    `User request: ${userPrompt}`,
  ].join("\n\n");

  await runCodexStructured({
    instruction,
    schemaPath: resolve(projectRoot, "schemas/filter-spec.json"),
    outputPath,
  });

  const generated = JSON.parse(await readFile(outputPath, "utf8")) as CodexOutput;
  const filter = filterSpecSchema.parse({
    id: `ai_${jobId}`,
    name: generated.name,
    description: generated.description,
    where: convertCodexNode(generated.root) ?? { type: "group", conjunction: "and", children: [] },
    ...(generated.sortField ? { sort: { field: generated.sortField, direction: generated.sortDirection } } : {}),
    limit: generated.limit,
  });
  repository.saveFilter(filter);
  return { filter, model: "gpt-5.6-luna", jobId };
}
