import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filterSpecSchema, type FilterExpression, type FilterSpec, type Product } from "../src/domain/catalog";
import { applyFilter } from "../src/domain/filter";
import { DEFAULT_CLOTHING_WORKSPACE_ID, type WorkspaceProfile } from "../src/domain/workspace";
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
  model: "gpt-5.6-luna" | "heuristic";
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

const standardFilterFields = new Set([
  "kind", "source", "brand", "name", "description", "price", "originalPrice", "discountPercent", "currency",
  "category", "color", "colorFamily", "fit", "materials", "tags", "sizes", "available", "stockStatus",
  "decision", "importedAt", "updatedAt", "searchText",
]);
const exactFacetFields = new Set(["kind", "source", "category", "color", "colorFamily", "fit", "currency", "decision", "stockStatus"]);

function valueAtFilterPath(product: Product, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, product);
}

function normalizedStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLocaleLowerCase("fr-CH"))
    .filter(Boolean);
}

export function normalizeCodexFilterForCatalog(
  expression: FilterExpression,
  products: Product[],
  dynamicFields: string[] = [],
): FilterExpression {
  if (expression.type === "group") {
    return { ...expression, children: expression.children.map((child) => normalizeCodexFilterForCatalog(child, products, dynamicFields)) };
  }
  if (expression.type === "not") {
    return { ...expression, child: normalizeCodexFilterForCatalog(expression.child, products, dynamicFields) };
  }

  const dynamic = new Set(dynamicFields);
  const values = normalizedStrings(expression.value);
  if (values.length === 0) return expression;
  const knownField = standardFilterFields.has(expression.field) || dynamic.has(expression.field);
  const syntheticListingText = expression.field === "listingText" || expression.field === "attributes.listingText";
  const exactButUnobserved = exactFacetFields.has(expression.field)
    && ["eq", "neq", "in", "not_in"].includes(expression.operator)
    && !values.some((expected) => products.some((product) => {
      const actual = valueAtFilterPath(product, expression.field);
      return (Array.isArray(actual) ? actual : [actual]).some((entry) => String(entry ?? "").trim().toLocaleLowerCase("fr-CH") === expected);
    }));
  if (!syntheticListingText && knownField && !exactButUnobserved) return expression;

  const negative = ["neq", "not_in", "not_contains"].includes(expression.operator);
  return {
    type: "clause",
    field: "searchText",
    operator: negative ? "not_contains" : "contains",
    value: Array.isArray(expression.value) ? expression.value : String(expression.value),
  };
}

const softPreferencePattern = /\b(?:plut[oô]t|un peu|assez|id[eé]alement|de préférence|rather|preferably|ideally|somewhat)\b/i;
const relaxablePreferenceFields = ["fit", "color", "colorFamily", "searchText", "tags"];

function withoutPositiveField(expression: FilterExpression, field: string): FilterExpression | null {
  if (expression.type === "clause") {
    return expression.field === field && ["eq", "in", "contains"].includes(expression.operator) ? null : expression;
  }
  if (expression.type === "not") return expression;
  const children = expression.children
    .map((child) => withoutPositiveField(child, field))
    .filter((child): child is FilterExpression => child !== null);
  return children.length ? { ...expression, children } : null;
}

export function relaxSoftFilterForCatalog(filter: FilterSpec, userPrompt: string, products: Product[]): FilterSpec {
  if (!softPreferencePattern.test(userPrompt) || applyFilter(products, filter).length > 0) return filter;
  for (const field of relaxablePreferenceFields) {
    const where = withoutPositiveField(filter.where, field);
    if (!where) continue;
    const candidate = { ...filter, where };
    if (applyFilter(products, candidate).length > 0) {
      return {
        ...candidate,
        description: `${filter.description}${filter.description ? " " : ""}Une préférence souple a été élargie faute de correspondance exacte.`,
      };
    }
  }
  return filter;
}

export async function createFilterWithCodex(
  userPrompt: string,
  repository = new CatalogRepository(),
  options: { workspaceId?: string; profile?: WorkspaceProfile } = {},
): Promise<CodexFilterResult> {
  if (!userPrompt.trim()) throw new Error("Filter prompt is empty.");
  const workspaceId = options.workspaceId ?? DEFAULT_CLOTHING_WORKSPACE_ID;
  const workspace = repository.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  const profile = options.profile ?? workspace.profile;
  const jobId = crypto.randomUUID();
  const jobsRoot = resolve(projectRoot, "data/codex-jobs");
  const outputPath = resolve(jobsRoot, `${jobId}.json`);
  await mkdir(jobsRoot, { recursive: true });

  const products = repository.listProducts({ workspaceId, limit: 10_000 });
  const definitions = repository.listFieldDefinitions(workspaceId);
  const fields = definitions.length ? definitions : repository.inferWorkspaceSchema(workspaceId);
  const facets = repository.getWorkspaceFacets(workspaceId, fields.filter((field) => field.facetable).map((field) => field.key));
  const facetsByKey = new Map(facets.map((facet) => [facet.fieldKey, facet]));
  const countBy = (values: string[]) => Object.fromEntries([...new Set(values)].map((value) => [
    value,
    values.filter((candidate) => candidate === value).length,
  ]).sort((left, right) => Number(right[1]) - Number(left[1])).slice(0, 40));
  const prices = products.flatMap((product) => product.price === null ? [] : [product.price]);
  const catalogStats = {
    workspace: { id: workspace.id, name: workspace.name, profile },
    products: products.length,
    sources: countBy(products.map((product) => product.source)),
    categories: countBy(products.map((product) => product.category)),
    fits: countBy(products.map((product) => product.fit)),
    colors: countBy(products.map((product) => product.colorFamily)),
    materials: countBy(products.flatMap((product) => product.materials)),
    tags: countBy(products.flatMap((product) => product.tags)),
    price: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    fields: fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.primitiveType,
      unit: field.unit,
      facetable: field.facetable,
      coverage: field.coverage,
      values: facetsByKey.get(field.key)?.values.slice(0, 30),
      min: facetsByKey.get(field.key)?.min,
      max: facetsByKey.get(field.key)?.max,
    })),
  };
  const profileGuidance = profile === "clothing"
    ? "This workspace contains clothing. Canonical clothing fields may include category, colorFamily, fit, materials, sizes, stockStatus, and attributes.sizeAvailabilityKnown. Use only values present in the workspace summary."
    : profile === "televisions"
      ? "This workspace contains televisions. Prefer the observed dynamic fields (for example attributes.screen_size or attributes.refresh_rate when present). Never introduce clothing categories, fits, materials, or sizes."
      : "This is a generic visual-products workspace. Make no domain assumptions: use only observed fields and values from the workspace summary.";
  const instruction = [
    "Translate the user's request below into one Mosaic FilterSpec for the active workspace.",
    "Return only the structured object required by the supplied output schema.",
    "Every expression node uses the same shape. For unused fields, use conjunction=none, operator=none, valueKind=none, empty value arrays, booleanValue=false, and empty children.",
    "A not node contains exactly one child. A group uses conjunction and children. A clause uses field, operator, valueKind, and the matching value array or boolean.",
    "Never add placeholder, padding, or no-op nodes to a group's children array.",
    "Use sortField='' when no explicit sort was requested.",
    "Do not call tools and do not edit files.",
    "Fields may be standard Product paths (kind, source, brand, name, description, price, originalPrice, discountPercent, currency, category, color, colorFamily, fit, materials, tags, sizes, stockStatus, available, decision, importedAt, updatedAt), the virtual searchText field, or one of the observed dynamic attributes.<name> paths in the workspace summary.",
    profileGuidance,
    "Use searchText with contains for subjective, translated, fuzzy, or descriptive intent such as textured, baggy, minimal, vintage, leather, or a term that is not an exact observed facet value. searchText combines all product text and common multilingual aliases. Never invent attributes.listingText.",
    "Use exact category/fit/color fields only with an exact value shown in the catalog summary. Otherwise use searchText contains.",
    "Use nested and/or/not expressions for complex logic. When the request says at least N among M criteria, encode that threshold faithfully (for at least 2 of 3: OR of the three possible AND pairs), rather than requiring all criteria.",
    "References have kind=reference and shop articles have kind=shop. Missing information must not be invented.",
    `Current catalog summary: ${JSON.stringify(catalogStats)}`,
    `User request: ${userPrompt}`,
  ].join("\n\n");

  let filter: FilterSpec;
  let model: CodexFilterResult["model"] = "gpt-5.6-luna";
  try {
    await runCodexStructured({
      instruction,
      schemaPath: resolve(projectRoot, "schemas/filter-spec.json"),
      outputPath,
    });
    const generated = JSON.parse(await readFile(outputPath, "utf8")) as CodexOutput;
    filter = filterSpecSchema.parse({
      id: `ai_${jobId}`,
      name: generated.name,
      description: generated.description,
      where: convertCodexNode(generated.root) ?? { type: "group", conjunction: "and", children: [] },
      ...(generated.sortField ? { sort: { field: generated.sortField, direction: generated.sortDirection } } : {}),
      limit: generated.limit,
    });
    filter = {
      ...filter,
      where: normalizeCodexFilterForCatalog(filter.where, products, fields.map((field) => field.key)),
    };
    filter = relaxSoftFilterForCatalog(filter, userPrompt, products);
  } catch {
    model = "heuristic";
    filter = filterSpecSchema.parse({
      id: `ai_${jobId}`,
      name: userPrompt.slice(0, 80) || "Filtre Mosaic",
      description: "Le plan local a conservé les contraintes explicites; Luna n’était pas disponible pour interpréter les nuances du texte.",
      where: { type: "group", conjunction: "and", children: [] },
      limit: Math.min(5_000, Math.max(1, products.length || 500)),
    });
  }
  repository.saveFilter(filter, workspaceId);
  return { filter, model, jobId };
}
