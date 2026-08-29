import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runCodexStructured } from "./codex-bridge";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const assistantActionSchema = z.enum(["filter", "similar", "visual", "discover", "import_links", "outfit", "clarify"]);
const policySchema = z.enum(["default", "explicit", "all"]);

export const assistantPlanSchema = z.object({
  action: assistantActionSchema,
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(800),
  query: z.string().trim().max(2_000),
  sizePolicy: policySchema,
  sizes: z.array(z.string().trim().min(1).max(30)).max(12),
  shopPolicy: policySchema,
  shops: z.array(z.string().trim().min(1).max(100)).max(12),
  pricePolicy: policySchema,
  minPrice: z.number().min(0).max(10_000),
  maxPrice: z.number().min(0).max(10_000),
  targetCount: z.number().int().min(1).max(300),
});

export type AssistantPlan = z.infer<typeof assistantPlanSchema> & {
  effectiveSizes: string[];
  effectiveShops: string[];
  effectiveMinPrice?: number;
  effectiveMaxPrice?: number;
  model: "gpt-5.6-luna" | "heuristic";
};

export type AssistantPlannerInput = {
  prompt: string;
  imageCount: number;
  productIds: string[];
  links: string[];
  defaults: {
    sizes: string[];
    shops: string[];
    minPrice?: number;
    maxPrice?: number;
  };
};

function normalizedSizes(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toLocaleUpperCase()).filter(Boolean))];
}

function effectivePlan(plan: z.infer<typeof assistantPlanSchema>, input: AssistantPlannerInput, model: AssistantPlan["model"]): AssistantPlan {
  const effectiveSizes = plan.sizePolicy === "default" ? normalizedSizes(input.defaults.sizes)
    : plan.sizePolicy === "explicit" ? normalizedSizes(plan.sizes) : [];
  const effectiveShops = plan.shopPolicy === "default" ? [...new Set(input.defaults.shops)]
    : plan.shopPolicy === "explicit" ? [...new Set(plan.shops)] : [];
  const effectiveMinPrice = plan.pricePolicy === "default" ? input.defaults.minPrice
    : plan.pricePolicy === "explicit" && plan.minPrice > 0 ? plan.minPrice : undefined;
  const effectiveMaxPrice = plan.pricePolicy === "default" ? input.defaults.maxPrice
    : plan.pricePolicy === "explicit" && plan.maxPrice > 0 ? plan.maxPrice : undefined;
  return { ...plan, effectiveSizes, effectiveShops, effectiveMinPrice, effectiveMaxPrice, model };
}

function explicitSizes(prompt: string): string[] {
  const match = /\b(?:tailles|taille|sizes|size)\b\s*(?:en|:|=)?\s*((?:(?:W\d{2}\/L\d{2}|XXL|XL|XS|XXS|[SML]|\d{2,3})(?:\s*(?:,|\/|ou|or|et|and)\s*)?)+)/i.exec(prompt);
  return match ? normalizedSizes(match[1].match(/W\d{2}\/L\d{2}|XXL|XL|XS|XXS|[SML]|\d{2,3}/gi) ?? []) : [];
}

function explicitShops(prompt: string): string[] {
  const shops: string[] = [];
  if (/zalando/i.test(prompt)) shops.push("zalando-ch");
  if (/about\s*you/i.test(prompt)) shops.push("aboutyou-ch");
  if (/ali\s*express/i.test(prompt)) shops.push("aliexpress");
  return shops;
}

function explicitPrice(prompt: string) {
  const max = /(?:moins de|max(?:imum)?|jusqu['’]?à|under)\s*(?:chf\s*)?(\d+(?:[.,]\d+)?)/i.exec(prompt);
  const min = /(?:plus de|min(?:imum)?|à partir de|over)\s*(?:chf\s*)?(\d+(?:[.,]\d+)?)/i.exec(prompt);
  return {
    min: min ? Number(min[1].replace(",", ".")) : 0,
    max: max ? Number(max[1].replace(",", ".")) : 0,
  };
}

export function heuristicAssistantPlan(input: AssistantPlannerInput): AssistantPlan {
  const prompt = input.prompt.trim();
  const lower = prompt.toLocaleLowerCase("fr-CH");
  const sizes = explicitSizes(prompt);
  const shops = explicitShops(prompt);
  const price = explicitPrice(prompt);
  const allSizes = /(?:toutes?|n['’]?importe quelle)\s+(?:les\s+)?tailles?|sans (?:filtre|contrainte) de taille/i.test(prompt);
  const allShops = /(?:toutes?|n['’]?importe quelle)\s+(?:les\s+)?(?:boutiques?|shops?|sites?)|sans (?:filtre|contrainte) de (?:boutique|shop|source)/i.test(prompt);
  const allPrices = /(?:tous|n['’]?importe quel)\s+(?:les\s+)?prix|sans (?:limite|filtre|contrainte) de prix/i.test(prompt);
  const requestedCount = /\b(\d{1,3})\s+(?:articles?|produits?|items?)\b/i.exec(prompt);
  const action = input.links.length && !prompt.replace(/https:\/\/\S+/g, "").trim() ? "import_links"
    : input.productIds.length && /simil|semblable|alternative|proche|same|like (?:this|these)/i.test(prompt) ? "similar"
      : /tenue|outfit|look|combine|porter avec|wear with/i.test(prompt) && input.productIds.length ? "outfit"
        : input.imageCount > 0 ? "visual"
          : /(?:nouveaux?|autres?) (?:articles?|produits?)|chercher? (?:sur|en ligne)|discover|scrap|boutique|shop/i.test(lower) ? "discover"
            : input.productIds.length ? "similar" : "filter";
  const base = assistantPlanSchema.parse({
    action,
    title: action === "similar" ? "Articles similaires" : action === "discover" ? "Recherche boutiques" : action === "visual" ? "Sélection visuelle" : action === "outfit" ? "Composer une tenue" : action === "import_links" ? "Importer les liens" : "Filtrer le catalogue",
    message: "Le routeur local a choisi l’action la plus directe.",
    query: prompt.replace(/https:\/\/\S+/g, "").trim(),
    sizePolicy: allSizes ? "all" : sizes.length ? "explicit" : "default",
    sizes,
    shopPolicy: allShops ? "all" : shops.length ? "explicit" : "default",
    shops,
    pricePolicy: allPrices ? "all" : price.min > 0 || price.max > 0 ? "explicit" : "default",
    minPrice: price.min,
    maxPrice: price.max,
    targetCount: requestedCount ? Math.min(300, Math.max(1, Number(requestedCount[1]))) : action === "discover" ? 120 : 30,
  });
  return effectivePlan(base, input, "heuristic");
}

export async function createAssistantPlanWithCodex(input: AssistantPlannerInput): Promise<AssistantPlan> {
  if (!input.prompt.trim() && !input.imageCount && !input.productIds.length && !input.links.length) {
    throw new Error("Assistant request is empty.");
  }
  const fallback = heuristicAssistantPlan(input);
  if (fallback.action === "import_links" && !input.prompt.replace(/https:\/\/\S+/g, "").trim()) return fallback;
  const jobId = crypto.randomUUID();
  const jobsRoot = resolve(projectRoot, "data/codex-jobs");
  const outputPath = resolve(jobsRoot, `${jobId}-assistant.json`);
  await mkdir(jobsRoot, { recursive: true });
  const instruction = [
    "Route one user request for the private local Wardrobe Atlas into exactly one primary action.",
    "Return only the object required by the supplied output schema. Do not call tools, browse, edit files, or purchase anything.",
    "Actions: filter searches the existing catalog by metadata; similar finds nearest existing products from attached catalog items; visual visually reranks the existing catalog from uploaded images or subtle visual criteria; discover searches supported shops for new products; import_links imports the supplied product pages; outfit composes outfits around attached catalog items; clarify is only for an actually unusable request.",
    "Direct product links are imported before the primary action. Choose import_links when importing those pages is the whole request; choose similar/visual/outfit when the user wants further work using them.",
    "Use explicit constraints in the user's text over defaults. sizePolicy=explicit with exact requested labels, all when the user removes size constraints, otherwise default. Apply the same policy logic to shops and price.",
    "Known searchable shop ids are zalando-ch, aboutyou-ch, and aliexpress. Other shops are supported through direct product links when their public page exposes Product JSON-LD.",
    "Use discover when the user asks for new online inventory, not when they only want to rearrange or filter the local board.",
    "Use visual when actual image inspection is necessary. Use similar for attached catalog items when local CLIP distance is sufficient.",
    `Default constraints: ${JSON.stringify(input.defaults)}`,
    `Uploaded image count: ${input.imageCount}`,
    `Attached catalog product ids: ${JSON.stringify(input.productIds)}`,
    `Direct product links: ${JSON.stringify(input.links)}`,
    `User request: ${input.prompt || "(attachments only)"}`,
  ].join("\n\n");
  try {
    await runCodexStructured({
      instruction,
      schemaPath: resolve(projectRoot, "schemas/assistant-plan.json"),
      outputPath,
      timeoutMs: 120_000,
    });
    return effectivePlan(assistantPlanSchema.parse(JSON.parse(await readFile(outputPath, "utf8"))), input, "gpt-5.6-luna");
  } catch {
    return fallback;
  }
}
