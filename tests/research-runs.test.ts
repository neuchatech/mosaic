import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../server/database";
import { CatalogRepository } from "../server/repository";
import {
  researchAgentResultSchema,
  researchRequestSchema,
  researchWorkspaceManifestSchema,
  type ResearchAgentResult,
  type ResearchRequest,
  type ResearchWorkspaceManifest,
} from "../src/domain/research";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

function createContext(): { db: Database.Database; repository: CatalogRepository } {
  const db = new Database(":memory:");
  migrateDatabase(db);
  return { db, repository: new CatalogRepository(db) };
}

function researchInput(
  repository: CatalogRepository,
  workspaceId: string,
): { request: ResearchRequest; manifest: ResearchWorkspaceManifest } {
  const request = researchRequestSchema.parse({
    workspaceId,
    prompt: "Find a compact, evidence-backed shortlist.",
    reasoningEffort: "medium",
    constraints: [{ field: "price", operator: "lte", value: 1_500 }],
    budget: { maxToolCalls: 12, maxImageInspections: 4 },
  });
  const workspace = repository.getWorkspace(workspaceId);
  assert.ok(workspace);
  const manifest = researchWorkspaceManifestSchema.parse({
    version: 1,
    workspace,
    fields: [],
    facets: [],
    counts: {
      items: 0,
      withImages: 0,
      withCoordinates: 0,
      byKind: {},
      bySource: {},
      byDecision: {},
    },
    selectedItems: [],
    selectedCollections: [],
    sources: [],
    constraints: request.constraints,
    budget: request.budget,
    visualIndex: {
      imagesAvailable: 0,
      coordinatesAvailable: 0,
      hybridEmbeddingsMayBeAvailable: false,
    },
  });
  return { request, manifest };
}

function partialResult(): ResearchAgentResult {
  return researchAgentResultSchema.parse({
    version: 1,
    outcome: "partial",
    title: "Useful partial result",
    message: "The bounded run retained the evidence gathered before stopping.",
    itemIds: [],
    collectionIds: [],
    artifactIds: [],
    filters: [],
    evidence: [{ kind: "warning", note: "One source was unavailable." }],
    warnings: ["One source was unavailable."],
    followUps: ["Resume with the same constraints."],
    metrics: {
      toolCalls: 3,
      itemsRead: 8,
      imagesInspected: 2,
      acquiredItems: 0,
    },
  });
}

test("research run migration is idempotent and persists typed JSON", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  migrateDatabase(db);
  const repository = new CatalogRepository(db);
  const { request, manifest } = researchInput(repository, DEFAULT_CLOTHING_WORKSPACE_ID);

  const created = repository.createResearchRun({
    id: "research-persistent",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    request,
    manifest,
    message: "Queued locally",
  });

  assert.equal(created.status, "queued");
  assert.equal(created.eventCount, 0);
  assert.deepEqual(created.request.budget, request.budget);
  assert.equal(created.manifest.workspace.id, DEFAULT_CLOTHING_WORKSPACE_ID);
  const raw = db.prepare(`
    SELECT input_json, budget_json, manifest_json, result_json FROM research_runs WHERE id = ?
  `).get(created.id) as Record<string, string | null>;
  assert.deepEqual(JSON.parse(raw.input_json!), request);
  assert.deepEqual(JSON.parse(raw.budget_json!), request.budget);
  assert.deepEqual(JSON.parse(raw.manifest_json!), manifest);
  assert.equal(raw.result_json, null);

  migrateDatabase(db);
  const reloaded = new CatalogRepository(db).getResearchRun(
    created.id,
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.deepEqual(reloaded, created);
  const tableCount = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN ('research_runs', 'research_run_events')
  `).get() as { count: number };
  assert.equal(tableCount.count, 2);
});

test("research runs and events are isolated by workspace", (t) => {
  const context = createContext();
  t.after(() => context.db.close());
  context.repository.createWorkspace({
    id: "workspace-other",
    name: "Other research",
    profile: "generic",
  });
  const clothing = researchInput(context.repository, DEFAULT_CLOTHING_WORKSPACE_ID);
  const other = researchInput(context.repository, "workspace-other");
  context.repository.createResearchRun({
    id: "research-clothing",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    ...clothing,
  });
  context.repository.createResearchRun({
    id: "research-other",
    workspaceId: "workspace-other",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    ...other,
  });

  assert.deepEqual(
    context.repository.listResearchRuns(DEFAULT_CLOTHING_WORKSPACE_ID).map(({ id }) => id),
    ["research-clothing"],
  );
  assert.deepEqual(
    context.repository.listResearchRuns("workspace-other").map(({ id }) => id),
    ["research-other"],
  );
  assert.equal(
    context.repository.getResearchRun("research-other", DEFAULT_CLOTHING_WORKSPACE_ID),
    null,
  );
  assert.equal(
    context.repository.updateResearchRun(
      "research-other",
      { status: "running" },
      DEFAULT_CLOTHING_WORKSPACE_ID,
    ),
    null,
  );
  assert.equal(
    context.repository.deleteResearchRun("research-other", DEFAULT_CLOTHING_WORKSPACE_ID),
    false,
  );
  assert.throws(() => context.repository.appendResearchRunEvent({
    runId: "research-other",
    type: "message",
    message: "Must remain hidden",
  }, DEFAULT_CLOTHING_WORKSPACE_ID), /Unknown research run/);
  assert.deepEqual(
    context.repository.listResearchRunEvents(
      "research-other",
      {},
      DEFAULT_CLOTHING_WORKSPACE_ID,
    ),
    [],
  );
  assert.throws(() => context.repository.createResearchRun({
    id: "research-mismatched-request",
    workspaceId: "workspace-other",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    request: clothing.request,
    manifest: other.manifest,
  }), /request and run/);
  assert.throws(() => context.repository.createResearchRun({
    id: "research-mismatched-manifest",
    workspaceId: "workspace-other",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    request: other.request,
    manifest: clothing.manifest,
  }), /manifest and run/);
});

test("research events append in order and status updates survive reload", (t) => {
  const context = createContext();
  t.after(() => context.db.close());
  const input = researchInput(context.repository, DEFAULT_CLOTHING_WORKSPACE_ID);
  context.repository.createResearchRun({
    id: "research-events",
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    ...input,
  });

  const first = context.repository.appendResearchRunEvent({
    runId: "research-events",
    type: "status",
    message: "Started",
  }, DEFAULT_CLOTHING_WORKSPACE_ID);
  const second = context.repository.appendResearchRunEvent({
    runId: "research-events",
    type: "tool-call",
    data: { tool: "query_items", attempt: 1 },
  }, DEFAULT_CLOTHING_WORKSPACE_ID);
  const third = context.repository.appendResearchRunEvent({
    runId: "research-events",
    type: "progress",
    data: { completed: 4, total: 12 },
  }, DEFAULT_CLOTHING_WORKSPACE_ID);
  assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
  assert.deepEqual(
    context.repository.listResearchRunEvents(
      "research-events",
      { afterSequence: 1, limit: 1 },
      DEFAULT_CLOTHING_WORKSPACE_ID,
    ),
    [second],
  );
  assert.equal(
    context.repository.getResearchRun("research-events", DEFAULT_CLOTHING_WORKSPACE_ID)?.eventCount,
    3,
  );

  const running = context.repository.updateResearchRun(
    "research-events",
    { status: "running", message: "Inspecting candidates" },
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.equal(running?.status, "running");
  assert.ok(running?.startedAt);
  assert.equal(running?.finishedAt, null);

  const result = partialResult();
  const finished = context.repository.setResearchRunStatus(
    "research-events",
    "partial",
    { result, message: result.message },
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.equal(finished?.status, "partial");
  assert.deepEqual(finished?.result, result);
  assert.equal(finished?.startedAt, running?.startedAt);
  assert.ok(finished?.finishedAt);

  const reloaded = new CatalogRepository(context.db).getResearchRun(
    "research-events",
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.deepEqual(reloaded, finished);
  assert.deepEqual(
    new CatalogRepository(context.db).listResearchRunEvents(
      "research-events",
      {},
      DEFAULT_CLOTHING_WORKSPACE_ID,
    ),
    [first, second, third],
  );
  const resumed = context.repository.updateResearchRun(
    "research-events",
    { status: "running", error: null },
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.finishedAt, null);
  assert.deepEqual(resumed?.result, result, "useful partial work survives an explicit resume");
  const interrupted = context.repository.updateResearchRun(
    "research-events",
    { status: "interrupted", message: "Server stopped before completion" },
    DEFAULT_CLOTHING_WORKSPACE_ID,
  );
  assert.equal(interrupted?.status, "interrupted");
  assert.ok(interrupted?.finishedAt);
  assert.equal(
    context.repository.deleteResearchRun("research-events", DEFAULT_CLOTHING_WORKSPACE_ID),
    true,
  );
  const eventCount = context.db.prepare(`
    SELECT COUNT(*) AS count FROM research_run_events WHERE run_id = 'research-events'
  `).get() as { count: number };
  assert.equal(eventCount.count, 0);
});
