import { z } from "zod";

export const legacyAssistantActionSchema = z.enum([
  "filter",
  "similar",
  "visual",
  "discover",
  "import_links",
  "outfit",
  "clarify",
]);

export const assistantPolicySchema = z.enum(["default", "explicit", "all"]);
export const assistantSelectionScopeSchema = z.enum([
  "workspace",
  "filtered_workspace",
  "selected_items",
  "selected_collections",
  "imported_urls",
  "previous_step",
]);

const stepBase = {
  id: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(120),
  dependsOn: z.array(z.string().trim().min(1).max(50)).max(11),
};

const scopedStepBase = {
  ...stepBase,
  scope: assistantSelectionScopeSchema,
  itemIds: z.array(z.string().trim().min(1).max(200)).max(160),
  collectionIds: z.array(z.string().trim().min(1).max(200)).max(12),
};

export const filterAssistantStepSchema = z.object({
  ...stepBase,
  type: z.literal("filter"),
  query: z.string().trim().max(2_000),
  targetCount: z.number().int().min(1).max(300),
}).strict();

export const importUrlsAssistantStepSchema = z.object({
  ...stepBase,
  type: z.literal("import_urls"),
  urls: z.array(z.string().url().regex(/^https?:\/\//i).max(2_000)).min(1).max(24),
  targetCount: z.number().int().min(1).max(24),
}).strict();

export const discoverAdapterAssistantStepSchema = z.object({
  ...stepBase,
  type: z.literal("discover_adapter"),
  query: z.string().trim().min(1).max(2_000),
  sources: z.array(z.string().trim().min(1).max(100)).max(12),
  targetCount: z.number().int().min(1).max(300),
}).strict();

export const enrichAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("enrich"),
  fields: z.array(z.string().trim().min(1).max(100)).min(1).max(24),
  targetCount: z.number().int().min(1).max(160),
}).strict();

export const similarityAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("similarity"),
  targetCount: z.number().int().min(1).max(100),
}).strict();

export const visualScoreAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("visual_score"),
  prompt: z.string().trim().min(1).max(2_000),
  candidateLimit: z.number().int().min(1).max(50),
  topN: z.number().int().min(1).max(24),
  threshold: z.number().min(0).max(1),
}).strict();

export const collectionAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("collection_operation"),
  operation: z.enum(["create", "update", "add_items", "remove_items"]),
  name: z.string().trim().max(120),
  targetCount: z.number().int().min(1).max(160),
}).strict();

export const compareAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("compare_summarize"),
  mode: z.enum(["compare", "summarize"]),
  question: z.string().trim().max(2_000),
  targetCount: z.number().int().min(1).max(60),
}).strict();

export const composeAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("compose"),
  profile: z.enum(["clothing", "televisions", "generic"]),
  kind: z.enum(["outfit", "domain_set"]),
  prompt: z.string().trim().max(2_000),
  targetCount: z.number().int().min(1).max(12),
}).strict();

export const artifactAssistantStepSchema = z.object({
  ...scopedStepBase,
  type: z.literal("artifact"),
  mode: z.enum(["draft", "generate"]),
  artifactKind: z.enum(["image", "mood_board", "comparison", "report", "studio"]),
  prompt: z.string().trim().max(2_000),
  targetCount: z.number().int().min(1).max(12),
}).strict();

export const clarifyAssistantStepSchema = z.object({
  ...stepBase,
  type: z.literal("clarify"),
  question: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const assistantStepSchema = z.discriminatedUnion("type", [
  filterAssistantStepSchema,
  importUrlsAssistantStepSchema,
  discoverAdapterAssistantStepSchema,
  enrichAssistantStepSchema,
  similarityAssistantStepSchema,
  visualScoreAssistantStepSchema,
  collectionAssistantStepSchema,
  compareAssistantStepSchema,
  composeAssistantStepSchema,
  artifactAssistantStepSchema,
  clarifyAssistantStepSchema,
]);

export const assistantPlanSchema = z.object({
  version: z.literal(1),
  action: legacyAssistantActionSchema,
  primaryStepId: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(800),
  query: z.string().trim().max(2_000),
  sizePolicy: assistantPolicySchema,
  sizes: z.array(z.string().trim().min(1).max(30)).max(12),
  shopPolicy: assistantPolicySchema,
  shops: z.array(z.string().trim().min(1).max(100)).max(12),
  pricePolicy: assistantPolicySchema,
  minPrice: z.number().min(0).max(10_000),
  maxPrice: z.number().min(0).max(10_000),
  targetCount: z.number().int().min(1).max(300),
  steps: z.array(assistantStepSchema).min(1).max(12),
}).strict();

export type AssistantStep = z.infer<typeof assistantStepSchema>;
export type AssistantPlanOutput = z.infer<typeof assistantPlanSchema>;
export type AssistantWorkspaceProfile = "clothing" | "televisions" | "generic";

export type AssistantPlannerInput = {
  prompt: string;
  imageCount: number;
  productIds: string[];
  links: string[];
  collectionIds?: string[];
  workspaceProfile?: AssistantWorkspaceProfile;
  defaults: {
    sizes: string[];
    shops: string[];
    minPrice?: number;
    maxPrice?: number;
  };
};

export type AssistantPlan = AssistantPlanOutput & {
  effectiveSizes: string[];
  effectiveShops: string[];
  effectiveMinPrice?: number;
  effectiveMaxPrice?: number;
  model: "gpt-5.6-luna" | "heuristic";
};

const searchableAdapterIds = new Set(["zalando-ch", "aboutyou-ch", "aliexpress"]);

function uniqueTrimmed(values: string[], normalize: (value: string) => string = (value) => value.trim()) {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

export function normalizedSizes(values: string[]) {
  return uniqueTrimmed(values, (value) => value.trim().toLocaleUpperCase().replace(/^3XL$/, "XXXL"));
}

function cleanPrompt(prompt: string) {
  return prompt.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

function inferProfile(input: AssistantPlannerInput): AssistantWorkspaceProfile {
  if (input.workspaceProfile) return input.workspaceProfile;
  if (/\b(?:tv|tvs|televisions?|télévisions?|téléviseurs?|oled|qled|mini[- ]?led|smart\s*tv)\b/i.test(input.prompt)) return "televisions";
  return "clothing";
}

function explicitSizes(prompt: string, profile: AssistantWorkspaceProfile): string[] {
  if (profile !== "clothing") return [];
  const values: string[] = [];
  const marked = /\b(?:tailles?|sizes?)\b\s*(?:en|:|=|de)?\s*([^.;\n]{1,60})/gi;
  for (const match of prompt.matchAll(marked)) {
    const sizeClause = match[1]?.split(/\b(?:sous|moins de|under|below|max(?:imum)?|budget|prix|chez|sur|from)\b/i, 1)[0] ?? "";
    values.push(...(sizeClause.match(/\b(?:W\d{2}(?:\/L\d{2})?|XXXL|3XL|XXL|XL|XS|XXS|[SML]|\d{2,3})\b/gi) ?? []));
  }
  const afterIn = /\b(?:en|disponibles? en)\s+(W\d{2}(?:\/L\d{2})?|XXXL|3XL|XXL|XL|XS|XXS|[SML])\b(?:(?:\s*[,/]\s*|\s+(?:ou|or|et|and)\s+)(W\d{2}(?:\/L\d{2})?|XXXL|3XL|XXL|XL|XS|XXS|[SML])\b)?/gi;
  for (const match of prompt.matchAll(afterIn)) values.push(...match.slice(1).filter((value): value is string => Boolean(value)));
  const pair = /\b(W\d{2}(?:\/L\d{2})?|XXXL|3XL|XXL|XL|XS|XXS|[SML])(?:\s*[,/]\s*|\s+(?:ou|or|et|and)\s+)(W\d{2}(?:\/L\d{2})?|XXXL|3XL|XXL|XL|XS|XXS|[SML])\b/gi;
  for (const match of prompt.matchAll(pair)) values.push(match[1]!, match[2]!);
  return normalizedSizes(values);
}

const sourceAliases: Array<[RegExp, string]> = [
  [/\bzalando\b/i, "zalando-ch"],
  [/\babout\s*you\b/i, "aboutyou-ch"],
  [/\bali\s*express\b/i, "aliexpress"],
  [/\bgalaxus\b/i, "galaxus-ch"],
  [/\bdigitec\b/i, "digitec-ch"],
  [/\bamazon(?:\.ch)?\b/i, "amazon-ch"],
];

function explicitShops(prompt: string): string[] {
  const shops = sourceAliases.filter(([pattern]) => pattern.test(prompt)).map(([, id]) => id);
  const canonicalCandidate = (candidate: string) => {
    const aliases: Record<string, string> = {
      zalando: "zalando-ch",
      about: "aboutyou-ch",
      ali: "aliexpress",
      galaxus: "galaxus-ch",
      digitec: "digitec-ch",
      amazon: "amazon-ch",
    };
    return aliases[candidate] ?? candidate;
  };
  for (const match of prompt.matchAll(/\b(?:source|boutique|shop|site)s?\b\s*(?:(?:=|:|chez|sur|from)\s*)?([a-z0-9][a-z0-9.-]{2,80})\b/gi)) {
    const candidate = match[1]!.toLocaleLowerCase();
    if (!new Set(["web", "internet", "marchand", "marchands", "supported"]).has(candidate)) shops.push(canonicalCandidate(candidate));
  }
  for (const match of prompt.matchAll(/\b(?:chez|from)\s+([a-z0-9][a-z0-9.-]{2,80})\b/gi)) {
    shops.push(canonicalCandidate(match[1]!.toLocaleLowerCase()));
  }
  for (const match of prompt.matchAll(/\b(?:sur|on)\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,20})\b/gi)) {
    shops.push(match[1]!.toLocaleLowerCase());
  }
  return uniqueTrimmed(shops, (value) => value.trim().toLocaleLowerCase());
}

export function requestsRemoteAcquisition(prompt: string, shops = explicitShops(prompt)) {
  if (!shops.length) return false;
  // The named source already provides the remote context. Keep the verb list
  // deliberately explicit so "show the About You socks I already have" stays
  // a local filter, while natural conjugations in every shipped UI language
  // reliably start discovery.
  const normalized = prompt
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
  return /(?:^|[^\p{L}])(?:ajoute(?:s|z|r)?|importe(?:s|z|r)?|scrape(?:s|z|r)?|scanne(?:s|z|r)?|cherche(?:s|z|r)?|trouve(?:s|z|r)?|recupere(?:s|z|r)?|ramene(?:s|z|r)?|add|import|scrape|scan|find|fetch|discover|retrieve|get|fuge|hinzufugen|importiere(?:n)?|suche(?:n)?|finde(?:n)?|hole(?:n)?|scrapen|scannen|aggiungi|aggiungere|importa(?:re)?|cerca(?:re)?|trova(?:re)?|recupera(?:re)?|scansiona(?:re)?|anade|anadir|agrega(?:r)?|busca(?:r)?|encuentra(?:r)?|recupera(?:r)?|escanea(?:r)?)(?=$|[^\p{L}])/u.test(normalized);
}

function explicitPrice(prompt: string) {
  const between = /(?:entre|between)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(?:et|and|à|to|-)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)/i.exec(prompt);
  const maximum = /(?:moins de|sous|max(?:imum)?|jusqu['’]?à|under|below|budget(?: de)?|<)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)/i.exec(prompt)
    ?? /(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(?:max(?:imum)?|ou moins)/i.exec(prompt);
  const minimum = /(?:plus de|min(?:imum)?|à partir de|over|above|>)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)/i.exec(prompt)
    ?? /(?:chf|fr\.?|€|eur|usd|\$)?\s*(\d+(?:[.,]\d+)?)\s*(?:chf|fr\.?|€|eur|usd|\$)?\s*(?:min(?:imum)?|ou plus)/i.exec(prompt);
  const parse = (value: string | undefined) => value ? Math.min(10_000, Math.max(0, Number(value.replace(",", ".")))) : 0;
  return {
    min: between ? parse(between[1]) : parse(minimum?.[1]),
    max: between ? parse(between[2]) : parse(maximum?.[1]),
  };
}

function requestsAllSizes(prompt: string) {
  return /(?:toutes?|n['’]?importe quelle)\s+(?:les\s+)?tailles?|sans (?:filtre|contrainte) de taille/i.test(prompt);
}

function requestsAllShops(prompt: string) {
  return /(?:toutes?|n['’]?importe quelle)\s+(?:les\s+)?(?:boutiques?|shops?|sites?|sources?)|sans (?:filtre|contrainte) de (?:boutique|shop|source)/i.test(prompt);
}

function requestsAllPrices(prompt: string) {
  return /(?:tous|n['’]?importe quel)\s+(?:les\s+)?prix|sans (?:limite|filtre|contrainte) de prix/i.test(prompt);
}

function requestedTargetCount(prompt: string) {
  const match = /\b(\d{1,3})\s+(?:articles?|produits?|items?|résultats?|results?|tvs?|télévisions?|looks?|tenues?|pantalons?|jeans?|vestes?|manteaux?|chemises?|t-?shirts?|pulls?|mailles?|cardigans?|chaussures?|baskets?|accessoires?|colliers?|bonnets?)\b/i.exec(prompt);
  return match ? Math.min(300, Math.max(1, Number(match[1]))) : undefined;
}

function compatibleAction(type: AssistantStep["type"]): AssistantPlanOutput["action"] {
  if (type === "import_urls") return "import_links";
  if (type === "discover_adapter") return "discover";
  if (type === "similarity") return "similar";
  if (type === "visual_score") return "visual";
  if (type === "compose") return "outfit";
  if (type === "clarify") return "clarify";
  return "filter";
}

function validateOrderedScopes(steps: AssistantStep[], input: AssistantPlannerInput) {
  const allowedItems = new Set(input.productIds.map((id) => id.trim()));
  const allowedCollections = new Set((input.collectionIds ?? []).map((id) => id.trim()));
  const allowedUrls = new Set(input.links.map((url) => url.trim()));
  const previousIds = new Set<string>();
  const plannedUrls = new Set<string>();
  let sawNonImportStep = false;

  for (const step of steps) {
    if (previousIds.has(step.id)) throw new Error(`Duplicate assistant step id: ${step.id}`);
    if (step.dependsOn.some((id) => !previousIds.has(id))) throw new Error(`Assistant step ${step.id} has an invalid forward dependency.`);
    if (step.type === "import_urls") {
      if (sawNonImportStep) throw new Error("Assistant URL imports must precede all dependent work.");
      if (step.urls.some((url) => !allowedUrls.has(url))) {
        throw new Error(`Assistant step ${step.id} references a URL outside the request.`);
      }
      step.urls.forEach((url) => plannedUrls.add(url));
    } else {
      sawNonImportStep = true;
    }
    if ("itemIds" in step && step.itemIds.some((id) => !allowedItems.has(id))) {
      throw new Error(`Assistant step ${step.id} references an item outside the selected scope.`);
    }
    if ("collectionIds" in step && step.collectionIds.some((id) => !allowedCollections.has(id))) {
      throw new Error(`Assistant step ${step.id} references a collection outside the selected scope.`);
    }
    if ("scope" in step) {
      if (step.scope === "selected_items" && !step.itemIds.length) throw new Error(`Assistant step ${step.id} requires selected items.`);
      if (step.scope === "selected_collections" && !step.collectionIds.length) throw new Error(`Assistant step ${step.id} requires selected collections.`);
      if (step.scope === "imported_urls" && !input.links.length) throw new Error(`Assistant step ${step.id} requires imported URLs.`);
      if (step.scope === "previous_step" && !step.dependsOn.length) throw new Error(`Assistant step ${step.id} requires a dependency.`);
    }
    if (step.type === "collection_operation" && step.operation !== "create" && !step.collectionIds.length) {
      throw new Error(`Assistant step ${step.id} requires a target collection.`);
    }
    previousIds.add(step.id);
  }
  if ([...allowedUrls].some((url) => !plannedUrls.has(url))) {
    throw new Error("Assistant plan omitted a supplied product URL.");
  }
}

function validatePrimaryDependencyClosure(steps: AssistantStep[], primaryStepId: string) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    byId.get(id)?.dependsOn.forEach(visit);
  };
  visit(primaryStepId);
  const orphaned = steps.filter((step) => !reachable.has(step.id));
  if (orphaned.length) {
    throw new Error(`Assistant plan contains steps outside the primary dependency chain: ${orphaned.map((step) => step.id).join(", ")}.`);
  }
}

export function finalizeAssistantPlan(
  parsed: AssistantPlanOutput,
  input: AssistantPlannerInput,
  model: AssistantPlan["model"],
): AssistantPlan {
  const plan = assistantPlanSchema.parse(parsed);
  validateOrderedScopes(plan.steps, input);
  const primary = plan.steps.find((step) => step.id === plan.primaryStepId);
  if (!primary) throw new Error("Assistant primaryStepId does not reference a plan step.");
  validatePrimaryDependencyClosure(plan.steps, plan.primaryStepId);

  const profile = inferProfile(input);
  const promptSizes = explicitSizes(input.prompt, profile);
  const promptShops = explicitShops(input.prompt);
  const promptPrice = explicitPrice(input.prompt);
  // Model output may interpret constraints, but it may not invent a size,
  // shop, or budget that is absent from both the prompt and the active UI.
  const sizePolicy = profile !== "clothing" || requestsAllSizes(input.prompt) ? "all"
    : promptSizes.length ? "explicit" : "default";
  const shopPolicy = requestsAllShops(input.prompt) ? "all"
    : promptShops.length ? "explicit" : "default";
  const pricePolicy = requestsAllPrices(input.prompt) ? "all"
    : promptPrice.min > 0 || promptPrice.max > 0 ? "explicit" : "default";
  const sizes = sizePolicy === "explicit" ? normalizedSizes(promptSizes.length ? promptSizes : plan.sizes) : [];
  const shops = shopPolicy === "explicit" ? uniqueTrimmed(promptShops.length ? promptShops : plan.shops, (value) => value.trim().toLocaleLowerCase()) : [];
  const minPrice = pricePolicy === "explicit" ? (promptPrice.min || plan.minPrice) : 0;
  const maxPrice = pricePolicy === "explicit" ? (promptPrice.max || plan.maxPrice) : 0;
  if (minPrice > 0 && maxPrice > 0 && minPrice > maxPrice) throw new Error("Assistant price bounds are reversed.");

  const targetCount = requestedTargetCount(input.prompt) ?? plan.targetCount;
  const effectiveSizes = sizePolicy === "default" ? normalizedSizes(input.defaults.sizes) : sizes;
  const effectiveShops = shopPolicy === "default" ? uniqueTrimmed(input.defaults.shops, (value) => value.trim().toLocaleLowerCase()) : shops;
  const effectiveMinPrice = pricePolicy === "default" ? input.defaults.minPrice : pricePolicy === "explicit" && minPrice > 0 ? minPrice : undefined;
  const effectiveMaxPrice = pricePolicy === "default" ? input.defaults.maxPrice : pricePolicy === "explicit" && maxPrice > 0 ? maxPrice : undefined;
  const plannedDiscoverySources = plan.steps.flatMap((step) => step.type === "discover_adapter" ? step.sources : []);
  if (plannedDiscoverySources.some((shop) => !searchableAdapterIds.has(shop))
    || (plan.steps.some((step) => step.type === "discover_adapter") && effectiveShops.some((shop) => !searchableAdapterIds.has(shop)))) {
    throw new Error("Assistant discovery references a source without an installed adapter.");
  }

  const steps = plan.steps.map((step) => {
    let normalizedStep: AssistantStep = step;
    if (step.type === "import_urls") normalizedStep = { ...step, targetCount: step.urls.length };
    else if (step.type === "visual_score") normalizedStep = {
      ...step,
      candidateLimit: Math.max(step.candidateLimit, step.topN),
    };
    if (step.id === plan.primaryStepId) {
      if (step.type === "filter" || step.type === "discover_adapter") normalizedStep = { ...step, targetCount };
      else if (step.type === "similarity") normalizedStep = { ...step, targetCount: Math.min(100, targetCount) };
      else if (step.type === "visual_score") normalizedStep = {
        ...step,
        topN: Math.min(60, targetCount),
      candidateLimit: Math.min(50, Math.max(step.candidateLimit, targetCount)),
      };
    }
    if (normalizedStep.type !== "discover_adapter") return normalizedStep;
    return { ...normalizedStep, sources: shopPolicy === "all" ? [] : effectiveShops };
  });

  return {
    ...plan,
    action: compatibleAction(primary.type),
    targetCount,
    sizePolicy,
    sizes,
    shopPolicy,
    shops,
    pricePolicy,
    minPrice,
    maxPrice,
    steps,
    effectiveSizes,
    effectiveShops,
    effectiveMinPrice,
    effectiveMaxPrice,
    model,
  };
}

function heuristicScope(input: AssistantPlannerInput, hasImport: boolean) {
  if (hasImport) return "imported_urls" as const;
  if (input.productIds.length) return "selected_items" as const;
  if (input.collectionIds?.length) return "selected_collections" as const;
  return "filtered_workspace" as const;
}

function scopedInputs(input: AssistantPlannerInput, scope: z.infer<typeof assistantSelectionScopeSchema>) {
  return {
    scope,
    itemIds: uniqueTrimmed(input.productIds),
    collectionIds: uniqueTrimmed(input.collectionIds ?? []),
  };
}

export function heuristicAssistantPlan(input: AssistantPlannerInput): AssistantPlan {
  const prompt = cleanPrompt(input.prompt);
  const lower = prompt.toLocaleLowerCase("fr-CH");
  const profile = inferProfile(input);
  const sizes = explicitSizes(prompt, profile);
  const shops = explicitShops(prompt);
  const price = explicitPrice(prompt);
  const targetFromPrompt = requestedTargetCount(prompt);
  const hasLinks = input.links.length > 0;
  const hasItems = input.productIds.length > 0;
  const hasCollections = Boolean(input.collectionIds?.length);
  const wantsCompare = /\b(?:compare|comparaison|versus|vs\.?|différences?|meilleur(?:e)? parmi)\b/i.test(prompt);
  const wantsSummary = /\b(?:résume|résumé|synthèse|summari[sz]e|recap)\b/i.test(prompt);
  const wantsArtifact = /\b(?:artefact|artifact|mood\s*board|planche|rapport|report|studio|génère? (?:une )?image|generate (?:an? )?image|brouillon|draft)\b/i.test(prompt);
  const wantsCollection = /\b(?:collection|favoris|favorites|shortlist)\b/i.test(prompt) && /\b(?:crée|create|ajoute|add|retire|remove|mets|save|sauve|update|renomme)\b/i.test(prompt);
  const wantsCompose = /\b(?:tenue|outfit|look|combine|composer?|porter avec|wear with|ensemble cohérent|set)\b/i.test(prompt);
  const wantsVisual = input.imageCount > 0 || /\b(?:visuels?|visuelles?|visuellement|visually|images?|mood|style exact|ressemble à la photo)\b/i.test(prompt);
  const wantsSimilar = /\b(?:similaires?|semblables?|alternatives?|proches?|same|like (?:this|these)|du même genre)\b/i.test(prompt);
  const wantsEnrich = /\b(?:enrich(?:is|it|ir|issement)?|refresh|rafraîchis?|actualise|mets? à jour)\b/i.test(prompt)
    || /\b(?:vérifie|contrôle|check|récupère|extrais)\b.{0,60}\b(?:détails?|specs?|spécifications?|stock|disponibilit[ée]|tailles?|prix)\b/i.test(prompt);
  const wantsDiscovery = requestsRemoteAcquisition(prompt, shops)
    || /\b(?:nouveaux?|autres?)\s+(?:articles?|produits?|tvs?|télévisions?)|\b(?:cherche|chercher|trouve|trouver|explore|discover|scan)\b.*\b(?:en ligne|web|boutiques?|shops?|sites?|sources?|zalando|about\s*you|aliexpress|galaxus|digitec|amazon)\b/i.test(lower);
  const unsupportedSources = shops.filter((shop) => !searchableAdapterIds.has(shop));
  const targetCount = targetFromPrompt ?? (wantsDiscovery ? 80 : wantsCompose ? 3 : hasLinks && !prompt ? input.links.length : 30);
  const steps: AssistantStep[] = [];
  type AssistantStepWithoutId = AssistantStep extends infer Step
    ? Step extends { id: string } ? Omit<Step, "id"> : never
    : never;
  const addStep = (step: AssistantStepWithoutId): AssistantStep => {
    const result = { ...step, id: `step_${steps.length + 1}` } as AssistantStep;
    steps.push(result);
    return result;
  };

  let importStep: AssistantStep | undefined;
  if (hasLinks) {
    importStep = addStep({
      type: "import_urls",
      title: input.links.length > 1 ? "Importer les liens publics" : "Importer le lien public",
      dependsOn: [],
      urls: uniqueTrimmed(input.links).slice(0, 24),
      targetCount: Math.min(24, Math.max(1, input.links.length)),
    });
  }

  let primaryStep: AssistantStep | undefined;
  let chainTail = importStep;
  if (wantsDiscovery && unsupportedSources.length) {
    primaryStep = addStep({
      type: "clarify",
      title: "Source non prise en charge en recherche large",
      dependsOn: importStep ? [importStep.id] : [],
      question: `Colle des liens produit publics de ${unsupportedSources.join(", ")}, ou choisis une source disposant d’un adaptateur.`,
      reason: "Une source explicitement demandée ne possède pas d’adaptateur de découverte; lancer une autre boutique violerait la contrainte.",
    });
  } else if (wantsDiscovery) {
    const discovery = addStep({
      type: "discover_adapter",
      title: "Explorer les sources prises en charge",
      dependsOn: importStep ? [importStep.id] : [],
      query: prompt || (profile === "televisions" ? "télévisions" : "produits"),
      sources: shops,
      targetCount,
    });
    primaryStep = discovery;
    chainTail = discovery;
    // Discovery itself applies its bounded size/price constraints. A distinct
    // detail-enrichment step is emitted when explicitly requested, or when the
    // durable artifact pipeline needs verified details before finalization.
    if (wantsEnrich || (wantsArtifact && (sizes.length || price.min > 0 || price.max > 0))) {
      chainTail = addStep({
        type: "enrich",
        title: "Vérifier les détails utiles",
        dependsOn: [discovery.id],
        ...scopedInputs(input, "previous_step"),
        fields: profile === "clothing" ? ["availability", "sizes", "price"] : ["availability", "price", "attributes"],
        targetCount: Math.min(160, targetCount),
      });
      if (wantsEnrich) primaryStep = chainTail;
    }
  }

  const derivedDependency = chainTail ? [chainTail.id] : [];
  const scope = derivedDependency.length ? "previous_step" as const : heuristicScope(input, false);
  const scopeInputs = scopedInputs(input, scope);

  if (wantsArtifact) {
    primaryStep = addStep({
      type: "artifact",
      title: /\b(?:génère|generate)\b/i.test(prompt) ? "Générer un artefact" : "Préparer un brouillon d’artefact",
      dependsOn: derivedDependency,
      ...scopeInputs,
      mode: /\b(?:génère|generate)\b/i.test(prompt) ? "generate" : "draft",
      artifactKind: /\b(?:rapport|report)\b/i.test(prompt) ? "report" : /\b(?:comparaison|comparison)\b/i.test(prompt) ? "comparison" : /\bstudio\b/i.test(prompt) ? "studio" : /\b(?:mood\s*board|planche)\b/i.test(prompt) ? "mood_board" : "image",
      prompt,
      targetCount: Math.min(12, targetFromPrompt ?? 1),
    });
  } else if (wantsCollection) {
    const operation = /\b(?:retire|remove)\b/i.test(prompt) ? "remove_items"
      : /\b(?:ajoute|add|mets|save|sauve)\b/i.test(prompt) ? "add_items"
        : /\b(?:update|renomme)\b/i.test(prompt) ? "update" : "create";
    if (operation !== "create" && !hasCollections) {
      primaryStep = addStep({
        type: "clarify",
        title: "Choisir la collection",
        dependsOn: derivedDependency,
        question: "Sélectionne la collection à modifier, puis relance la demande.",
        reason: "Une opération de collection ne doit pas deviner sa destination.",
      });
    } else {
      primaryStep = addStep({
        type: "collection_operation",
        title: operation === "create" ? "Créer une collection" : "Mettre à jour la collection",
        dependsOn: derivedDependency,
        ...scopeInputs,
        collectionIds: uniqueTrimmed(input.collectionIds ?? []),
        operation,
        name: "",
        targetCount: Math.min(160, targetCount),
      });
    }
  } else if (wantsCompare || wantsSummary) {
    primaryStep = addStep({
      type: "compare_summarize",
      title: wantsCompare ? "Comparer la sélection" : "Résumer la sélection",
      dependsOn: derivedDependency,
      ...scopeInputs,
      mode: wantsCompare ? "compare" : "summarize",
      question: prompt,
      targetCount: Math.min(60, Math.max(1, hasItems ? input.productIds.length : hasCollections ? input.collectionIds!.length : input.links.length || targetCount)),
    });
  } else if (wantsCompose) {
    if (!hasItems && !hasCollections && !hasLinks && !primaryStep) {
      primaryStep = addStep({
        type: "clarify",
        title: "Choisir un point de départ",
        dependsOn: [],
        question: profile === "clothing" ? "Sélectionne au moins une pièce ou une collection pour composer la tenue." : "Sélectionne des produits ou une collection à composer.",
        reason: "La composition demandée dépend d’éléments de départ qui ne sont pas sélectionnés.",
      });
    } else {
      primaryStep = addStep({
        type: "compose",
        title: profile === "clothing" ? "Composer une tenue" : "Composer un ensemble",
        dependsOn: derivedDependency,
        ...scopeInputs,
        profile,
        kind: profile === "clothing" ? "outfit" : "domain_set",
        prompt,
        targetCount: Math.min(12, targetFromPrompt ?? 3),
      });
    }
  } else if (wantsVisual) {
    primaryStep = addStep({
      type: "visual_score",
      title: "Évaluer visuellement les candidats",
      dependsOn: derivedDependency,
      ...scopeInputs,
      prompt: prompt || "Trouve les articles visuellement cohérents avec les images jointes.",
      candidateLimit: Math.min(50, Math.max(24, targetCount * 2)),
      topN: Math.min(20, targetCount),
      threshold: 0.55,
    });
  } else if (wantsSimilar || (hasItems && !primaryStep && !wantsEnrich)) {
    if (!hasItems && !hasCollections && !hasLinks && !primaryStep) {
      primaryStep = addStep({
        type: "clarify",
        title: "Ajouter une référence",
        dependsOn: [],
        question: "Sélectionne un article, une collection ou colle un lien avant de demander des alternatives similaires.",
        reason: "La similarité nécessite un point d’ancrage explicite.",
      });
    } else {
      primaryStep = addStep({
        type: "similarity",
        title: "Trouver des éléments similaires",
        dependsOn: derivedDependency,
        ...scopeInputs,
        targetCount: Math.min(100, targetCount),
      });
    }
  } else if (wantsEnrich && !primaryStep) {
    if (!hasItems && !hasCollections && !hasLinks) {
      primaryStep = addStep({
        type: "clarify",
        title: "Choisir les éléments à enrichir",
        dependsOn: [],
        question: "Sélectionne des éléments ou colle des liens à enrichir.",
        reason: "Un enrichissement sans scope risquerait de lancer un travail distant non borné.",
      });
    } else {
      primaryStep = addStep({
        type: "enrich",
        title: "Enrichir les éléments sélectionnés",
        dependsOn: importStep ? [importStep.id] : [],
        ...scopedInputs(input, importStep ? "previous_step" : heuristicScope(input, false)),
        fields: profile === "clothing" ? ["availability", "sizes", "price"] : ["availability", "price", "attributes"],
        targetCount: Math.min(160, Math.max(1, hasItems ? input.productIds.length : hasCollections ? input.collectionIds!.length : input.links.length)),
      });
    }
  } else if (!primaryStep && importStep) {
    primaryStep = importStep;
  } else if (!primaryStep && hasCollections) {
    primaryStep = addStep({
      type: "compare_summarize",
      title: "Résumer la collection",
      dependsOn: [],
      ...scopedInputs(input, "selected_collections"),
      mode: "summarize",
      question: prompt,
      targetCount: Math.min(60, input.collectionIds!.length),
    });
  } else if (!primaryStep) {
    primaryStep = addStep({
      type: "filter",
      title: profile === "clothing" ? "Filtrer le catalogue" : "Filtrer l’espace",
      dependsOn: [],
      query: prompt,
      targetCount,
    });
  }

  const sizePolicy = profile !== "clothing" || requestsAllSizes(prompt) ? "all" : sizes.length ? "explicit" : "default";
  const shopPolicy = requestsAllShops(prompt) ? "all" : shops.length ? "explicit" : "default";
  const pricePolicy = requestsAllPrices(prompt) ? "all" : price.min > 0 || price.max > 0 ? "explicit" : "default";
  const raw = assistantPlanSchema.parse({
    version: 1,
    action: compatibleAction(primaryStep.type),
    primaryStepId: primaryStep.id,
    title: primaryStep.title,
    message: primaryStep.type === "clarify" ? primaryStep.question : `Plan local borné en ${steps.length} étape${steps.length > 1 ? "s" : ""}.`,
    query: prompt,
    sizePolicy,
    sizes: sizePolicy === "explicit" ? sizes : [],
    shopPolicy,
    shops: shopPolicy === "explicit" ? shops : [],
    pricePolicy,
    minPrice: pricePolicy === "explicit" ? price.min : 0,
    maxPrice: pricePolicy === "explicit" ? price.max : 0,
    targetCount,
    steps,
  });
  return finalizeAssistantPlan(raw, input, "heuristic");
}
