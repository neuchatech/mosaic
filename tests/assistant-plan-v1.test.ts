import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assistantPlanSchema,
  finalizeAssistantPlan,
  heuristicAssistantPlan,
  type AssistantPlannerInput,
} from "../server/assistant-plan";

function plannerInput(overrides: Partial<AssistantPlannerInput> = {}): AssistantPlannerInput {
  return {
    prompt: "",
    imageCount: 0,
    productIds: [],
    collectionIds: [],
    links: [],
    defaults: {
      sizes: ["M", "L"],
      shops: ["zalando-ch", "aboutyou-ch", "aliexpress"],
      minPrice: 20,
      maxPrice: 250,
    },
    ...overrides,
  };
}

test("clothing discovery preserves source, sizes, price and bounded count in ordered steps", () => {
  const plan = heuristicAssistantPlan(plannerInput({
    prompt: "Trouve 80 articles homme automne sur Zalando, tailles M ou L, sous CHF 200",
    workspaceProfile: "clothing",
  }));

  assert.equal(plan.action, "discover");
  assert.equal(plan.targetCount, 80);
  assert.equal(plan.sizePolicy, "explicit");
  assert.deepEqual(plan.effectiveSizes, ["M", "L"]);
  assert.equal(plan.shopPolicy, "explicit");
  assert.deepEqual(plan.effectiveShops, ["zalando-ch"]);
  assert.equal(plan.pricePolicy, "explicit");
  assert.equal(plan.effectiveMaxPrice, 200);
  assert.deepEqual(plan.steps.map((step) => step.type), ["discover_adapter"]);
  assert.equal(plan.primaryStepId, plan.steps[0]?.id);
});

test("recognized multi-word shops stay canonical after natural connective phrases", () => {
  const plan = heuristicAssistantPlan(plannerInput({
    prompt: "Create a combined mood board from About You",
    workspaceProfile: "clothing",
  }));

  assert.equal(plan.shopPolicy, "explicit");
  assert.deepEqual(plan.effectiveShops, ["aboutyou-ch"]);
});

test("stock is a local filter unless the user explicitly asks to refresh it", () => {
  const filter = heuristicAssistantPlan(plannerInput({
    prompt: "Montre uniquement les vestes brunes en stock sous CHF 200 dans cet espace",
    workspaceProfile: "clothing",
  }));
  assert.equal(filter.steps[0]?.type, "filter");
  assert.equal(filter.action, "filter");

  const refresh = heuristicAssistantPlan(plannerInput({
    prompt: "Vérifie le stock et les tailles de cette sélection",
    workspaceProfile: "clothing",
    productIds: ["item-a"],
  }));
  assert.equal(refresh.steps[0]?.type, "enrich");
});

test("the model cannot invent constraints absent from the prompt and active UI", () => {
  const input = plannerInput({ prompt: "Montre les vestes brunes en stock", workspaceProfile: "clothing" });
  const parsed = assistantPlanSchema.parse({
    version: 1,
    action: "filter",
    primaryStepId: "step_1",
    title: "Filter",
    message: "Bounded plan",
    query: input.prompt,
    sizePolicy: "explicit",
    sizes: ["S"],
    shopPolicy: "explicit",
    shops: ["zalando-ch"],
    pricePolicy: "explicit",
    minPrice: 50,
    maxPrice: 100,
    targetCount: 30,
    steps: [{ id: "step_1", type: "filter", title: "Filter", dependsOn: [], query: input.prompt, targetCount: 30 }],
  });
  const plan = finalizeAssistantPlan(parsed, input, "gpt-5.6-luna");
  assert.equal(plan.sizePolicy, "default");
  assert.deepEqual(plan.effectiveSizes, ["M", "L"]);
  assert.equal(plan.shopPolicy, "default");
  assert.deepEqual(plan.effectiveShops, ["zalando-ch", "aboutyou-ch", "aliexpress"]);
  assert.equal(plan.pricePolicy, "default");
  assert.equal(plan.effectiveMinPrice, 20);
  assert.equal(plan.effectiveMaxPrice, 250);
});

test("multiple unknown-shop links import first and then compare their results", () => {
  const links = [
    "https://one.example/products/a",
    "https://two.example/item/b",
    "https://three.example/p/c",
  ];
  const plan = heuristicAssistantPlan(plannerInput({
    prompt: "Compare ces trois liens et résume les différences",
    links,
    workspaceProfile: "generic",
  }));

  assert.deepEqual(plan.steps.map((step) => step.type), ["import_urls", "compare_summarize"]);
  assert.deepEqual(plan.steps[0]?.type === "import_urls" ? plan.steps[0].urls : [], links);
  assert.deepEqual(plan.steps[1]?.dependsOn, [plan.steps[0]?.id]);
  assert.equal(plan.steps[1]?.type === "compare_summarize" ? plan.steps[1].scope : "", "previous_step");
  assert.equal(plan.primaryStepId, plan.steps[1]?.id);
  assert.equal(plan.sizePolicy, "all");
  assert.deepEqual(plan.effectiveSizes, []);
});

test("a higher-level artifact waits for discovery enrichment", () => {
  const plan = heuristicAssistantPlan(plannerInput({
    prompt: "Trouve 12 pulls sur Zalando en taille M puis crée un mood board",
    workspaceProfile: "clothing",
  }));

  assert.deepEqual(plan.steps.map((step) => step.type), ["discover_adapter", "enrich", "artifact"]);
  assert.deepEqual(plan.steps[2]?.dependsOn, [plan.steps[1]?.id]);
  assert.equal(plan.primaryStepId, plan.steps[2]?.id);
  assert.equal(plan.steps[2]?.type === "artifact" ? plan.steps[2].mode : "", "draft");
});

test("an unsupported explicit broad source clarifies instead of substituting an adapter", () => {
  const plan = heuristicAssistantPlan(plannerInput({
    prompt: "Cherche 20 télévisions OLED sur Galaxus",
    workspaceProfile: "televisions",
  }));

  assert.equal(plan.action, "clarify");
  assert.equal(plan.steps[0]?.type, "clarify");
  assert.equal(plan.shopPolicy, "explicit");
  assert.deepEqual(plan.effectiveShops, ["galaxus-ch"]);
  assert.deepEqual(plan.effectiveSizes, []);
  assert.match(plan.message, /liens produit publics|adaptateur/i);
});

test("selected items and collections remain explicit reusable scopes", () => {
  const similarity = heuristicAssistantPlan(plannerInput({
    prompt: "Trouve 12 alternatives similaires en XL ou XXL",
    productIds: ["item-a", "item-b"],
  }));
  assert.equal(similarity.action, "similar");
  assert.equal(similarity.steps[0]?.type, "similarity");
  assert.deepEqual(similarity.steps[0]?.type === "similarity" ? similarity.steps[0].itemIds : [], ["item-a", "item-b"]);
  assert.deepEqual(similarity.effectiveSizes, ["XL", "XXL"]);

  const collection = heuristicAssistantPlan(plannerInput({
    collectionIds: ["collection-autumn"],
    workspaceProfile: "generic",
  }));
  assert.equal(collection.steps[0]?.type, "compare_summarize");
  assert.equal(collection.steps[0]?.type === "compare_summarize" ? collection.steps[0].scope : "", "selected_collections");
  assert.deepEqual(collection.steps[0]?.type === "compare_summarize" ? collection.steps[0].collectionIds : [], ["collection-autumn"]);
});

test("finalization rejects out-of-scope ids and forward dependencies", () => {
  const input = plannerInput({ productIds: ["allowed"] });
  const offScope = assistantPlanSchema.parse({
    version: 1,
    action: "similar",
    primaryStepId: "step_1",
    title: "Similar",
    message: "Bounded plan",
    query: "similar",
    sizePolicy: "default",
    sizes: [],
    shopPolicy: "default",
    shops: [],
    pricePolicy: "default",
    minPrice: 0,
    maxPrice: 0,
    targetCount: 10,
    steps: [{
      id: "step_1",
      type: "similarity",
      title: "Similar",
      dependsOn: [],
      scope: "selected_items",
      itemIds: ["outside"],
      collectionIds: [],
      targetCount: 10,
    }],
  });
  assert.throws(() => finalizeAssistantPlan(offScope, input, "gpt-5.6-luna"), /outside the selected scope/);

  const forward = assistantPlanSchema.parse({
    ...offScope,
    steps: [
      { ...offScope.steps[0], itemIds: ["allowed"], dependsOn: ["step_2"] },
      { id: "step_2", type: "filter", title: "Filter", dependsOn: [], query: "", targetCount: 10 },
    ],
  });
  assert.throws(() => finalizeAssistantPlan(forward, input, "gpt-5.6-luna"), /invalid forward dependency/);

  const orphaned = assistantPlanSchema.parse({
    ...offScope,
    primaryStepId: "step_1",
    steps: [
      { id: "step_1", type: "discover_adapter", title: "Discover", dependsOn: [], query: "knits", sources: ["aboutyou-ch"], targetCount: 10 },
      { id: "step_2", type: "enrich", title: "Enrich", dependsOn: ["step_1"], scope: "previous_step", itemIds: [], collectionIds: [], fields: ["sizes"], targetCount: 10 },
    ],
  });
  assert.throws(() => finalizeAssistantPlan(orphaned, plannerInput(), "gpt-5.6-luna"), /outside the primary dependency chain/);

  const linkedInput = plannerInput({ links: ["https://shop.example/product/1"] });
  const missingImport = assistantPlanSchema.parse({
    version: 1,
    action: "filter",
    primaryStepId: "step_1",
    title: "Filter",
    message: "Bounded plan",
    query: "filter",
    sizePolicy: "default",
    sizes: [],
    shopPolicy: "default",
    shops: [],
    pricePolicy: "default",
    minPrice: 0,
    maxPrice: 0,
    targetCount: 10,
    steps: [{ id: "step_1", type: "filter", title: "Filter", dependsOn: [], query: "filter", targetCount: 10 }],
  });
  assert.throws(() => finalizeAssistantPlan(missingImport, linkedInput, "gpt-5.6-luna"), /omitted a supplied product URL/);
});

test("JSON output schema exposes every V1 typed primitive", () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/assistant-plan.json"), "utf8")) as {
    properties: { steps: { items: { oneOf: Array<{ properties: { type: { const: string } } }> } } };
  };
  const types = schema.properties.steps.items.oneOf.map((variant) => variant.properties.type.const);
  assert.deepEqual(types, [
    "filter",
    "import_urls",
    "discover_adapter",
    "enrich",
    "similarity",
    "visual_score",
    "collection_operation",
    "compare_summarize",
    "compose",
    "artifact",
    "clarify",
  ]);
});
