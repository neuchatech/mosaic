import assert from "node:assert/strict";
import test from "node:test";
import { codexDiscoveryPlanSchema, finalizeDiscoveryPlan } from "../server/codex-discovery";

test("explicit AliExpress requests survive a Zalando-only generated plan", () => {
  const generated = codexDiscoveryPlanSchema.parse({
    name: "Large plan",
    description: "Generated plan",
    targetCount: 180,
    searches: Array.from({ length: 8 }, (_, index) => ({
      source: "zalando-ch",
      query: `zalando search ${index}`,
      category: index % 2 ? "Vestes" : "Pantalons",
      minPrice: 0,
      maxPrice: 0,
      maxItems: 14,
      reason: "Relevant clothing search.",
    })),
  });
  const final = finalizeDiscoveryPlan(generated, "180 articles sur Zalando et AliExpress, avec colliers et bonnets");
  assert.equal(final.searches.length, 10);
  assert.equal(final.searches.filter((search) => search.source === "aliexpress").length, 2);
  assert.equal(final.searches.reduce((sum, search) => sum + search.maxItems, 0), 180);
  assert.equal(final.targetCount, 180);
});

test("displayed target never exceeds executable search capacity", () => {
  const generated = codexDiscoveryPlanSchema.parse({
    name: "Small plan",
    description: "Generated plan",
    targetCount: 300,
    searches: [{
      source: "zalando-ch",
      query: "brown cardigan",
      category: "Mailles",
      minPrice: 0,
      maxPrice: 0,
      maxItems: 10,
      reason: "Relevant knitwear search.",
    }],
  });
  const final = finalizeDiscoveryPlan(generated, "cardigans");
  assert.equal(final.targetCount, 60);
  assert.equal(final.searches[0]?.maxItems, 60);
});
