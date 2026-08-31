import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  researchAgentInstruction,
  researchCodexArgs,
  ResearchAgentService,
} from "../server/research-agent";
import { createApp } from "../server/app";
import { buildResearchManifest } from "../server/research-context";
import { CatalogRepository } from "../server/repository";
import { deleteCatalogMedia } from "../server/media";
import { researchRequestSchema, type ResearchAgentResult } from "../src/domain/research";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

function repositoryFixture() {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  return { database, repository: new CatalogRepository(database) };
}

function result(overrides: Partial<ResearchAgentResult> = {}): ResearchAgentResult {
  return {
    version: 1,
    outcome: "completed",
    title: "Research complete",
    message: "A diverse local selection is ready.",
    itemIds: [],
    collectionIds: [],
    artifactIds: [],
    filters: [],
    evidence: [{ kind: "fact", id: "workspace", note: "The workspace was inspected.", url: null }],
    warnings: [],
    followUps: [],
    metrics: { toolCalls: 2, itemsRead: 0, imagesInspected: 0, acquiredItems: 0 },
    ...overrides,
  };
}

test("research service persists lifecycle and compact tool progress", async (t) => {
  const { database, repository } = repositoryFixture();
  t.after(() => database.close());
  const service = new ResearchAgentService(repository, {
    idFactory: () => "research-test",
    runner: async ({ onEvent }) => {
      onEvent({ type: "tool-call", message: "Using query_workspace_items", data: { tool: "query_workspace_items" } });
      onEvent({ type: "tool-result", message: "Completed query_workspace_items", data: { count: 12 } });
      return result();
    },
  });
  const queued = service.start({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID, prompt: "Find a visually diverse set." });
  assert.equal(queued.status, "queued");
  const completed = await service.waitFor(queued.id, queued.workspaceId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result?.outcome, "completed");
  assert.ok(completed.finishedAt);
  const events = service.events(completed.id, completed.workspaceId);
  assert.deepEqual(events.map((event) => event.type), ["status", "status", "tool-call", "tool-result", "result"]);
  assert.equal(events[2]?.data.tool, "query_workspace_items");
  const assistant = repository.listAssistantMessages(
    completed.request.conversationId!,
    completed.workspaceId,
  ).find((message) => message.role === "assistant");
  assert.deepEqual(assistant?.context.actionRecap, [
    { type: "tool-call", message: "Using query_workspace_items", createdAt: events[2]!.createdAt },
    { type: "tool-result", message: "Completed query_workspace_items", createdAt: events[3]!.createdAt },
  ]);
});

test("research runs are cancelled explicitly and are not auto-resumed", async (t) => {
  const { database, repository } = repositoryFixture();
  t.after(() => database.close());
  let runnerStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => { runnerStarted = resolvePromise; });
  const service = new ResearchAgentService(repository, {
    idFactory: () => "research-cancel",
    runner: async ({ signal, onEvent }) => {
      runnerStarted();
      onEvent({
        type: "progress",
        message: "Started child work",
        data: { childJobs: [{ kind: "discovery", id: "discover-one" }, { kind: "acquisition", id: "refresh-one" }] },
      });
      await new Promise<void>((_resolvePromise, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
      return result();
    },
  });
  let cancelledChildren: Array<{ kind: string; id: string }> = [];
  service.setCancellationHandler((_run, children) => { cancelledChildren = children; });
  const queued = service.start({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID, prompt: "Keep exploring until cancelled." });
  await started;
  const cancelled = service.cancel(queued.id, queued.workspaceId);
  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(cancelledChildren, [
    { kind: "discovery", id: "discover-one" },
    { kind: "acquisition", id: "refresh-one" },
  ]);
  assert.equal((await service.waitFor(queued.id, queued.workspaceId)).status, "cancelled");
  assert.throws(() => service.resume(queued.id, queued.workspaceId), /cannot resume/);
});

test("research rejects invented or out-of-scope final ids", async (t) => {
  const { database, repository } = repositoryFixture();
  t.after(() => database.close());
  const service = new ResearchAgentService(repository, {
    idFactory: () => "research-invalid-output",
    runner: async () => result({ itemIds: ["invented-item"] }),
  });
  const queued = service.start({ workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID, prompt: "Return a real selection." });
  const finished = await service.waitFor(queued.id, queued.workspaceId);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /invalid item ids: invented-item/);
  assert.equal(finished.result, null);
});

test("restart recovery marks active work interrupted and resumes only on request", async (t) => {
  const { database, repository } = repositoryFixture();
  t.after(() => database.close());
  const request = researchRequestSchema.parse({
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    prompt: "Continue a persisted research task.",
  });
  const manifest = buildResearchManifest(request, repository);
  repository.createResearchRun({
    id: "research-restart",
    workspaceId: request.workspaceId,
    model: "gpt-5.6-luna",
    reasoningEffort: request.reasoningEffort,
    request,
    manifest,
  });
  repository.updateResearchRun("research-restart", { status: "running", startedAt: new Date().toISOString() });
  const service = new ResearchAgentService(repository, { runner: async () => result({ outcome: "partial" }) });
  assert.equal(service.markInterruptedRuns(), 1);
  assert.equal(service.get("research-restart", request.workspaceId)?.status, "interrupted");
  assert.equal(service.list(request.workspaceId)[0]?.status, "interrupted");
  const resumed = service.resume("research-restart", request.workspaceId);
  assert.equal(resumed.status, "queued");
  const finished = await service.waitFor(resumed.id, resumed.workspaceId);
  assert.equal(finished.status, "partial");
});

test("Codex research invocation exposes only scoped MCP in a read-only sandbox", () => {
  const { database, repository } = repositoryFixture();
  try {
    const request = researchRequestSchema.parse({
      workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
      prompt: "Explore objects with unusual surface treatment.",
      constraints: [{ field: "attributes.texture", operator: "exists", strength: "soft", weight: .8 }],
    });
    const run = repository.createResearchRun({
      id: "research-argv",
      workspaceId: request.workspaceId,
      model: "gpt-5.6-luna",
      reasoningEffort: request.reasoningEffort,
      request,
      manifest: buildResearchManifest(request, repository),
    });
    const args = researchCodexArgs(run, "/tmp/research-result.json");
    assert.ok(args.includes("read-only"));
    assert.ok(!args.includes("--approve-for-me"));
    assert.ok(args.includes("--strict-config"));
    assert.ok(args.includes("mcp_servers.mosaic.default_tools_approval_mode=\"approve\""));
    assert.ok(args.some((value) => value.includes("MOSAIC_RESEARCH_RUN_ID")));
    assert.ok(args.some((value) => value.includes("MOSAIC_RESEARCH_WORKSPACE_ID")));
    const instruction = researchAgentInstruction(run);
    assert.match(instruction, /any kind of item or reference/i);
    assert.match(instruction, /choose, revise, and stop your own research strategy/i);
    assert.match(instruction, /CLIP is a retrieval hint, not a verdict/i);
    assert.match(instruction, /validate_research_result/i);
    assert.match(instruction, /at most three validation attempts/i);
    assert.doesNotMatch(instruction, /clothing discovery|television workflow/i);
    const outputSchema = readFileSync(new URL("../schemas/research-agent-result.json", import.meta.url), "utf8");
    assert.doesNotMatch(outputSchema, /"oneOf"/);
    assert.match(outputSchema, /"required": \["id", "name", "description", "where", "sort", "limit"\]/);
  } finally {
    database.close();
  }
});

test("research HTTP API stores inputs locally and exposes the run through Activity", async (t) => {
  const { database, repository } = repositoryFixture();
  const service = new ResearchAgentService(repository, {
    idFactory: () => "research-api",
    runner: async () => result({ itemIds: [] }),
  });
  const app = createApp(repository, undefined, undefined, { researchAgent: service });
  let mediaId = "";
  t.after(async () => {
    if (mediaId) await deleteCatalogMedia(mediaId).catch(() => undefined);
    database.close();
  });

  const response = await app.request("/api/research/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
      prompt: "Use this image as visual context without assuming its domain.",
      images: [{
        name: "reference.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }],
    }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const payload = await response.json() as { run: { id: string; request: { images: Array<{ mediaPath: string }> } } };
  assert.equal(payload.run.id, "research-api");
  assert.match(payload.run.request.images[0]?.mediaPath ?? "", /^\/api\/media\/research-/);
  mediaId = decodeURIComponent(payload.run.request.images[0]!.mediaPath.split("/")[3]!);
  const finished = await service.waitFor("research-api", DEFAULT_CLOTHING_WORKSPACE_ID);
  assert.equal(finished.status, "succeeded");

  const activity = await app.request(`/api/runs?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`);
  const activityPayload = await activity.json() as { runs: Array<{ id: string; kind: string }> };
  assert.ok(activityPayload.runs.some((run) => run.id === "research-api" && run.kind === "research"));
  const events = await app.request(`/api/research/runs/research-api/events?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`);
  assert.equal(events.status, 200);
  assert.ok(((await events.json()) as { events: unknown[] }).events.length >= 3);

  const deleted = await app.request(`/api/research/runs/research-api?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  const missing = await app.request(`/api/research/runs/research-api?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`);
  assert.equal(missing.status, 404);
});

test("assistant conversations persist replies and feed prior context into follow-up runs", async (t) => {
  const { database, repository } = repositoryFixture();
  t.after(() => database.close());
  let sequence = 0;
  const histories: Array<Array<{ role: string; content: string }>> = [];
  const service = new ResearchAgentService(repository, {
    idFactory: () => `conversation-run-${++sequence}`,
    runner: async ({ run }) => {
      histories.push((run.manifest.conversation?.messages ?? []).map(({ role, content }) => ({ role, content })));
      return result({
        title: `Reply ${sequence}`,
        message: sequence === 1 ? "The first answer." : "The contextual follow-up answer.",
      });
    },
  });
  const app = createApp(repository, undefined, undefined, { researchAgent: service });
  const firstResponse = await app.request("/api/research/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
      prompt: "Start a reusable visual research conversation.",
    }),
  });
  assert.equal(firstResponse.status, 202);
  const firstPayload = await firstResponse.json() as { run: { id: string; request: { conversationId: string } } };
  const conversationId = firstPayload.run.request.conversationId;
  await service.waitFor(firstPayload.run.id, DEFAULT_CLOTHING_WORKSPACE_ID);

  const secondResponse = await app.request("/api/research/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
      conversationId,
      prompt: "Now refine that answer without starting over.",
    }),
  });
  assert.equal(secondResponse.status, 202);
  const secondPayload = await secondResponse.json() as { run: { id: string } };
  await service.waitFor(secondPayload.run.id, DEFAULT_CLOTHING_WORKSPACE_ID);

  assert.deepEqual(histories[0], []);
  assert.deepEqual(histories[1]?.map(({ role }) => role), ["user", "assistant"]);
  assert.equal(histories[1]?.[1]?.content, "The first answer.");

  const threadResponse = await app.request(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}?workspaceId=${DEFAULT_CLOTHING_WORKSPACE_ID}`,
  );
  assert.equal(threadResponse.status, 200);
  const thread = await threadResponse.json() as {
    conversation: { id: string };
    messages: Array<{ role: string; content: string; researchRunId: string }>;
  };
  assert.equal(thread.conversation.id, conversationId);
  assert.deepEqual(thread.messages.map(({ role }) => role), ["user", "assistant", "user", "assistant"]);
  assert.equal(thread.messages.at(-1)?.content, "The contextual follow-up answer.");
});
