import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runCodexStructured } from "./codex-bridge";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const discoverySearchSchema = z.object({
  source: z.enum(["zalando-ch", "aliexpress"]),
  query: z.string().trim().min(1).max(180),
  category: z.string().trim().min(1).max(80),
  minPrice: z.number().min(0).max(10_000),
  maxPrice: z.number().min(0).max(10_000),
  maxItems: z.number().int().min(1).max(60),
  reason: z.string().trim().min(1).max(500),
});

export const codexDiscoveryPlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  targetCount: z.number().int().min(1).max(300),
  searches: z.array(discoverySearchSchema).min(1).max(10),
});

type GeneratedDiscoveryPlan = z.infer<typeof codexDiscoveryPlanSchema>;

const maximumSearches = 10;
const maximumItemsPerSearch = 60;

const aliExpressFallbacks: GeneratedDiscoveryPlan["searches"] = [
  {
    source: "aliexpress",
    query: "men vintage pendant necklace stainless steel brown black",
    category: "Accessoires",
    minPrice: 0,
    maxPrice: 0,
    maxItems: 30,
    reason: "Colliers et pendentifs masculins sobres, sombres ou vintage.",
  },
  {
    source: "aliexpress",
    query: "men rib knit beanie brown olive beige charcoal",
    category: "Accessoires",
    minPrice: 0,
    maxPrice: 0,
    maxItems: 30,
    reason: "Bonnets texturés dans la palette du moodboard.",
  },
];

function ensureSourceMinimum(
  searches: GeneratedDiscoveryPlan["searches"],
  source: GeneratedDiscoveryPlan["searches"][number]["source"],
  minimum: number,
  fallbacks: GeneratedDiscoveryPlan["searches"],
) {
  const result = searches.map((search) => ({ ...search }));
  let sourceCount = result.filter((search) => search.source === source).length;
  let fallbackIndex = 0;
  while (sourceCount < minimum && fallbackIndex < fallbacks.length) {
    const fallback = { ...fallbacks[fallbackIndex++]! };
    if (result.length < maximumSearches) result.push(fallback);
    else {
      const replacement = result.findLastIndex((search) => search.source !== source);
      if (replacement < 0) break;
      result[replacement] = fallback;
    }
    sourceCount += 1;
  }
  return result;
}

function rebalanceSearchCapacity(searches: GeneratedDiscoveryPlan["searches"], requestedTarget: number) {
  const result = searches.map((search) => ({ ...search }));
  const target = Math.max(result.length, Math.min(300, requestedTarget));
  let total = result.reduce((sum, search) => sum + search.maxItems, 0);
  while (total < target) {
    const candidate = result
      .filter((search) => search.maxItems < maximumItemsPerSearch)
      .sort((left, right) => left.maxItems - right.maxItems)[0];
    if (!candidate) break;
    candidate.maxItems += 1;
    total += 1;
  }
  while (total > target) {
    const candidate = result
      .filter((search) => search.maxItems > 1)
      .sort((left, right) => right.maxItems - left.maxItems)[0];
    if (!candidate) break;
    candidate.maxItems -= 1;
    total -= 1;
  }
  return { searches: result, targetCount: total };
}

/** Enforce the source mix and target count promised by the UI. */
export function finalizeDiscoveryPlan(generated: GeneratedDiscoveryPlan, userPrompt: string) {
  let searches = generated.searches.map((search) => ({ ...search }));
  if (/ali\s*express/i.test(userPrompt)) {
    searches = ensureSourceMinimum(searches, "aliexpress", 2, aliExpressFallbacks);
  }
  const balanced = rebalanceSearchCapacity(searches, generated.targetCount);
  return { ...generated, ...balanced };
}

export type CodexDiscoveryPlan = z.infer<typeof codexDiscoveryPlanSchema> & {
  id: string;
  sizes: ["M", "L"];
  sizeMode: "any";
  model: "gpt-5.6-luna";
};

export async function createDiscoveryPlanWithCodex(userPrompt: string): Promise<CodexDiscoveryPlan> {
  if (!userPrompt.trim()) throw new Error("Discovery prompt is empty.");
  const id = crypto.randomUUID();
  const jobsRoot = resolve(projectRoot, "data/codex-jobs");
  const outputPath = resolve(jobsRoot, `${id}-discovery.json`);
  await mkdir(jobsRoot, { recursive: true });

  const instruction = [
    "Create one bounded product-discovery plan for the private, local-first Wardrobe Atlas app.",
    "Return only the object required by the supplied output schema.",
    "The plan is executed later by allowlisted local Playwright shop adapters. Do not browse, call tools, provide URLs, automate login, mention checkout, or suggest CAPTCHA/anti-bot bypasses.",
    "Each search query must be a concise retailer search phrase, not a natural-language paragraph.",
    "Allowed sources: zalando-ch for clothing, footwear and accessories; aliexpress mainly for inexpensive accessories or jewelry unless the user explicitly requests more.",
    "Use canonical French categories when possible: Vestes, Pantalons, Mailles, Chemises, T-shirts, Chaussures, Accessoires.",
    "For garments, the executor will enforce availability in M OR L. Do not put sizes in the query. Accessories such as necklaces and hats can ignore garment sizes.",
    "Keep the plan diverse and directly relevant. Split distinct categories or style directions into separate searches. Avoid near-duplicate searches.",
    "If the user explicitly names both Zalando and AliExpress, include at least two AliExpress accessory searches and at least two Zalando searches.",
    "The sum of maxItems across searches must equal targetCount. Use up to 10 searches when needed.",
    "Use minPrice=0 or maxPrice=0 when the user did not specify that bound. Never exceed 60 items per search or 300 items total.",
    `User request: ${userPrompt}`,
  ].join("\n\n");

  await runCodexStructured({
    instruction,
    schemaPath: resolve(projectRoot, "schemas/discovery-plan.json"),
    outputPath,
  });

  const generated = finalizeDiscoveryPlan(
    codexDiscoveryPlanSchema.parse(JSON.parse(await readFile(outputPath, "utf8"))),
    userPrompt,
  );
  return {
    ...generated,
    id,
    sizes: ["M", "L"],
    sizeMode: "any",
    model: "gpt-5.6-luna",
  };
}
