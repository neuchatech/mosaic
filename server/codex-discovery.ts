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
  searches: z.array(discoverySearchSchema).min(1).max(8),
});

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
    "Use minPrice=0 or maxPrice=0 when the user did not specify that bound. Never exceed 60 items per search or 300 items total.",
    `User request: ${userPrompt}`,
  ].join("\n\n");

  await runCodexStructured({
    instruction,
    schemaPath: resolve(projectRoot, "schemas/discovery-plan.json"),
    outputPath,
  });

  const generated = codexDiscoveryPlanSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
  let remaining = generated.targetCount;
  const searches = generated.searches.flatMap((search) => {
    if (remaining <= 0) return [];
    const maxItems = Math.min(search.maxItems, remaining);
    remaining -= maxItems;
    return [{ ...search, maxItems }];
  });
  return {
    ...generated,
    searches,
    id,
    sizes: ["M", "L"],
    sizeMode: "any",
    model: "gpt-5.6-luna",
  };
}
