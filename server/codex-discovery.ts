import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runCodexStructured } from "./codex-bridge";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const discoverySearchSchema = z.object({
  source: z.enum(["zalando-ch", "aboutyou-ch", "aliexpress"]),
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

const aboutYouFallbacks: GeneratedDiscoveryPlan["searches"] = [
  { source: "aboutyou-ch", query: "short workwear and bomber jackets", category: "Vestes", minPrice: 0, maxPrice: 220, maxItems: 30, reason: "Vestes homme courtes, structurées et faciles à superposer." },
  { source: "aboutyou-ch", query: "wide relaxed pleated trousers", category: "Pantalons", minPrice: 0, maxPrice: 170, maxItems: 30, reason: "Pantalons homme larges ou relax pour structurer les silhouettes." },
  { source: "aboutyou-ch", query: "textured cardigans and knitwear", category: "Mailles", minPrice: 0, maxPrice: 180, maxItems: 30, reason: "Cardigans et mailles texturées dans la direction du moodboard." },
  { source: "aboutyou-ch", query: "relaxed shirts overshirts", category: "Chemises", minPrice: 0, maxPrice: 150, maxItems: 30, reason: "Chemises et surchemises homme pour le layering." },
  { source: "aboutyou-ch", query: "heavyweight plain layering t-shirts", category: "T-shirts", minPrice: 0, maxPrice: 90, maxItems: 30, reason: "Bases homme sobres et faciles à superposer." },
  { source: "aboutyou-ch", query: "retro sneakers loafers boots", category: "Chaussures", minPrice: 0, maxPrice: 220, maxItems: 30, reason: "Chaussures sobres et rétro pour compléter les silhouettes." },
  { source: "aboutyou-ch", query: "men hats bags scarves", category: "Accessoires", minPrice: 0, maxPrice: 140, maxItems: 30, reason: "Accessoires homme faciles à combiner, dont bonnets et sacs." },
];

function ensureSourceMinimum(
  searches: GeneratedDiscoveryPlan["searches"],
  source: GeneratedDiscoveryPlan["searches"][number]["source"],
  minimum: number,
  fallbacks: GeneratedDiscoveryPlan["searches"],
  protectedSources: ReadonlySet<GeneratedDiscoveryPlan["searches"][number]["source"]> = new Set(),
) {
  const result = searches.map((search) => ({ ...search }));
  let sourceCount = result.filter((search) => search.source === source).length;
  let fallbackIndex = 0;
  while (sourceCount < minimum && fallbackIndex < fallbacks.length) {
    const fallback = { ...fallbacks[fallbackIndex++]! };
    if (result.length < maximumSearches) result.push(fallback);
    else {
      const replacement = result.findLastIndex((search) => (
        search.source !== source && !protectedSources.has(search.source)
      ));
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
  const aboutYouOnly = /(?:uniquement|seulement|exclusivement)\s+(?:sur\s+)?about\s*you|about\s*you\s+(?:uniquement|seulement|exclusivement)/i.test(userPrompt);
  const wantsAboutYou = /about\s*you/i.test(userPrompt);
  const wantsAliExpress = /ali\s*express/i.test(userPrompt);
  if (aboutYouOnly) {
    searches = searches.filter((search) => search.source === "aboutyou-ch");
    searches = ensureSourceMinimum(searches, "aboutyou-ch", 7, aboutYouFallbacks);
  } else {
    if (wantsAboutYou) {
      searches = ensureSourceMinimum(
        searches,
        "aboutyou-ch",
        5,
        aboutYouFallbacks,
        wantsAliExpress ? new Set(["aliexpress"]) : new Set(),
      );
    }
    if (wantsAliExpress) {
      searches = ensureSourceMinimum(
        searches,
        "aliexpress",
        2,
        aliExpressFallbacks,
        wantsAboutYou ? new Set(["aboutyou-ch"]) : new Set(),
      );
    }
  }
  const balanced = rebalanceSearchCapacity(searches, generated.targetCount);
  return { ...generated, ...balanced };
}

export type CodexDiscoveryPlan = z.infer<typeof codexDiscoveryPlanSchema> & {
  id: string;
  sizes: string[];
  sizeMode: "any";
  model: "gpt-5.6-luna";
};

export async function createDiscoveryPlanWithCodex(
  userPrompt: string,
  options: { sizes?: string[] } = {},
): Promise<CodexDiscoveryPlan> {
  if (!userPrompt.trim()) throw new Error("Discovery prompt is empty.");
  const id = crypto.randomUUID();
  const jobsRoot = resolve(projectRoot, "data/codex-jobs");
  const outputPath = resolve(jobsRoot, `${id}-discovery.json`);
  await mkdir(jobsRoot, { recursive: true });
  const requestedSizes = options.sizes === undefined ? ["M", "L"] : options.sizes;

  const instruction = [
    "Create one bounded product-discovery plan for the private, local-first Wardrobe Atlas app.",
    "Return only the object required by the supplied output schema.",
    "The plan is executed later by allowlisted local Playwright shop adapters. Do not browse, call tools, provide URLs, automate login, mention checkout, or suggest CAPTCHA/anti-bot bypasses.",
    "Each search query must be a concise retailer search phrase, not a natural-language paragraph.",
    "Allowed sources: zalando-ch for broad fashion discovery; aboutyou-ch for Swiss men's clothing, footwear and accessories with exact listing sizes; aliexpress mainly for inexpensive accessories or jewelry unless the user explicitly requests more.",
    "Use canonical French categories when possible: Vestes, Pantalons, Mailles, Chemises, T-shirts, Chaussures, Accessoires.",
    requestedSizes.length
      ? `For garments, the executor will enforce availability in ${requestedSizes.join(" OR ")}. Do not put sizes in the query. Accessories such as necklaces and hats can ignore garment sizes.`
      : "The user explicitly removed garment-size constraints. Do not put sizes in the query.",
    "Keep the plan diverse and directly relevant. Split distinct categories or style directions into separate searches. Avoid near-duplicate searches.",
    "If the user explicitly names About You, allocate at least five searches to aboutyou-ch across distinct categories. If the user names AliExpress, include at least two AliExpress accessory searches.",
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
    sizes: [...new Set(requestedSizes
      .map((size) => size.trim().toLocaleUpperCase()).filter(Boolean))],
    sizeMode: "any",
    model: "gpt-5.6-luna",
  };
}
