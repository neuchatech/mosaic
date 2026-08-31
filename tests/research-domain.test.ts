import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  researchAgentResultSchema,
  researchConstraintSchema,
  researchRequestSchema,
} from "../src/domain/research";
import { CatalogRepository } from "../server/repository";
import { buildResearchManifest } from "../server/research-context";

test("research requests are domain-neutral and require useful context", () => {
  const request = researchRequestSchema.parse({
    workspaceId: "default-clothing",
    prompt: "Compare the most visually distinctive objects and keep a diverse shortlist.",
    constraints: [
      { field: "attributes.period", operator: "in", value: ["1970s", "1980s"], strength: "soft", weight: 0.7 },
      { field: "price", operator: "lte", value: 400, strength: "hard" },
    ],
  });
  assert.equal(request.reasoningEffort, "medium");
  assert.equal(request.budget.maxImageInspections, 30);
  assert.equal(request.constraints[0]?.field, "attributes.period");
  assert.throws(() => researchRequestSchema.parse({ workspaceId: "default-clothing" }));
  assert.throws(() => researchRequestSchema.parse({ workspaceId: "default-clothing", urls: ["file:///tmp/item.html"] }));
  assert.throws(() => researchConstraintSchema.parse({ field: "price", operator: "between", value: [10] }));
});

test("multilingual outcomes remain raw agent context instead of fixed intent routes", () => {
  const outcomes = [
    ["fr-CH", "Ajoute des canapés de jardin modulaires et compare les matières."],
    ["en", "Build a moodboard of abstract printmaking with rough ink textures."],
    ["de-CH", "Finde kompakte Telefone mit besonders guten Kameras."],
    ["it-CH", "Raggruppa questi riferimenti per atmosfera visiva."],
  ] as const;
  for (const [locale, prompt] of outcomes) {
    const request = researchRequestSchema.parse({ workspaceId: "default-clothing", locale, prompt });
    assert.equal(request.prompt, prompt);
    assert.equal(request.locale, locale);
  }
  const longPrompt = "detailed context. ".repeat(2_000).trim();
  assert.equal(researchRequestSchema.parse({ workspaceId: "default-clothing", prompt: longPrompt }).prompt, longPrompt);
});

test("research results retain reusable selections and evidence", () => {
  const result = researchAgentResultSchema.parse({
    version: 1,
    outcome: "partial",
    title: "A useful first pass",
    message: "Twelve items match; two sources could not be refreshed.",
    itemIds: ["item-a", "item-b"],
    collectionIds: ["collection-a"],
    artifactIds: [],
    filters: [],
    evidence: [{ kind: "source", id: "shop-a", note: "Structured records were available.", url: null }],
    warnings: ["Live availability is unknown."],
    followUps: ["Refresh the shortlisted records later."],
    metrics: { toolCalls: 9, itemsRead: 80, imagesInspected: 12, acquiredItems: 0 },
  });
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.itemIds, ["item-a", "item-b"]);
});

test("workspace manifests are inferred from actual fields instead of profile prompts", () => {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  const repository = new CatalogRepository(database);
  const workspace = repository.createWorkspace({ name: "Sculptures", description: "Modern sculpture references", profile: "generic" });
  repository.commitWorkspaceSchema(workspace.id, [{
    workspaceId: workspace.id,
    key: "attributes.medium",
    label: "Medium",
    primitiveType: "enum",
    facetable: true,
    display: true,
  }]);
  const manifest = buildResearchManifest(researchRequestSchema.parse({
    workspaceId: workspace.id,
    prompt: "Find works with contrasting material treatments.",
  }), repository);
  assert.equal(manifest.workspace.name, "Sculptures");
  assert.deepEqual(manifest.fields.map((field) => field.key), ["attributes.medium"]);
  assert.ok(manifest.sources.some((source) => source.id === "public-url"));
  assert.equal(manifest.sources.find((source) => source.id === "public-url")?.availability, "available");
  assert.equal(manifest.sources.find((source) => source.id === "interactive-browser")?.availability, "unavailable");
  assert.ok(!JSON.stringify(manifest).includes("garment"));
  database.close();
});
