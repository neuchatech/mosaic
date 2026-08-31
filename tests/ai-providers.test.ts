import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  aiProviderCatalog,
  resolveAiProvider,
  runOpenAiCompatibleResearchAgent,
  type ResearchToolClient,
} from "../server/ai-providers";
import type { ResearchAgentResult, ResearchRun } from "../src/domain/research";
import { ResearchAgentService } from "../server/research-agent";
import { CatalogRepository } from "../server/repository";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

function result(): ResearchAgentResult {
  return {
    version: 1,
    outcome: "completed",
    title: "Done",
    message: "The workspace was researched.",
    itemIds: [],
    collectionIds: [],
    artifactIds: [],
    filters: [],
    evidence: [],
    warnings: [],
    followUps: [],
    metrics: { toolCalls: 0, itemsRead: 0, imagesInspected: 0, acquiredItems: 0 },
  };
}

function run(): ResearchRun {
  return {
    id: "provider-run",
    workspaceId: "workspace-one",
    model: "local-model",
    request: {
      budget: { maxToolCalls: 4, maxDurationMs: 30_000 },
    },
  } as ResearchRun;
}

test("provider catalog resolves Codex, local OpenAI-compatible, and OpenRouter without exposing keys", () => {
  const environment = {
    MOSAIC_AI_PROVIDER: "local",
    MOSAIC_LOCAL_AI_MODEL: "qwen-local",
    MOSAIC_LOCAL_AI_BASE_URL: "http://localhost:1234/v1/",
    OPENROUTER_API_KEY: "secret-key",
    MOSAIC_OPENROUTER_MODEL: "anthropic/claude-sonnet",
  };
  const catalog = aiProviderCatalog(environment);
  assert.equal(catalog.defaultProvider, "local");
  assert.deepEqual(catalog.providers.map(({ id, configured }) => [id, configured]), [
    ["codex", true],
    ["local", true],
    ["openrouter", true],
  ]);
  assert.equal(JSON.stringify(catalog).includes("secret-key"), false);
  assert.deepEqual(resolveAiProvider("local", null, environment), {
    id: "local",
    model: "qwen-local",
    baseUrl: "http://localhost:1234/v1",
    apiKey: undefined,
  });
  assert.throws(() => resolveAiProvider("local", null, {
    ...environment,
    MOSAIC_LOCAL_AI_BASE_URL: "http://192.168.1.9:1234/v1",
  }), /loopback/);
});

test("OpenAI-compatible agent executes scoped MCP tools and returns validated JSON", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let completion = 0;
  const requestFetch: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    completion += 1;
    const body = completion === 1
      ? {
        choices: [{ message: {
          content: null,
          tool_calls: [{
            id: "call-one",
            type: "function",
            function: { name: "get_research_context", arguments: "{}" },
          }],
        } }],
      }
      : { choices: [{ message: { content: JSON.stringify(result()) } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const called: string[] = [];
  const toolClient: ResearchToolClient = {
    async listTools() {
      return { tools: [{ name: "get_research_context", description: "Read scoped context", inputSchema: { type: "object" } }] };
    },
    async callTool(input) {
      called.push(input.name);
      return { structuredContent: { workspaceId: "workspace-one" } };
    },
    async close() {},
  };
  const events: string[] = [];
  const output = await runOpenAiCompatibleResearchAgent({
    run: run(),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.type),
  }, {
    provider: { id: "local", model: "local-model", baseUrl: "http://127.0.0.1:1234/v1" },
    instruction: "Research this workspace.",
    fetch: requestFetch,
    createToolClient: async () => toolClient,
  });
  assert.equal(output.outcome, "completed");
  assert.equal(output.metrics.toolCalls, 1);
  assert.deepEqual(called, ["get_research_context"]);
  assert.deepEqual(events, ["tool-call", "tool-result"]);
  assert.equal(requests.length, 2);
  const secondMessages = requests[1]?.messages as Array<{ role: string; tool_call_id?: string }>;
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.equal(secondMessages.at(-1)?.tool_call_id, "call-one");
});

test("automatic provider is resolved once and persisted with the research run", async (t) => {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  t.after(() => database.close());
  const repository = new CatalogRepository(database);
  const service = new ResearchAgentService(repository, {
    environment: {
      MOSAIC_AI_PROVIDER: "local",
      MOSAIC_LOCAL_AI_MODEL: "qwen-tool-model",
      MOSAIC_LOCAL_AI_BASE_URL: "http://127.0.0.1:1234/v1",
    },
    runner: async () => result(),
  });
  const queued = service.start({
    workspaceId: DEFAULT_CLOTHING_WORKSPACE_ID,
    prompt: "Research with my automatic provider.",
    provider: "auto",
  });
  const finished = await service.waitFor(queued.id, queued.workspaceId);
  assert.equal(finished.request.provider, "local");
  assert.equal(finished.request.model, "qwen-tool-model");
  assert.equal(finished.model, "qwen-tool-model");
  assert.equal(finished.status, "succeeded");
});
