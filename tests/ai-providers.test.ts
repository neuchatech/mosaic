import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviderCatalog,
  resolveAiProvider,
  runOpenAiCompatibleResearchAgent,
  type ResearchToolClient,
} from "../server/ai-providers";
import type { ResearchAgentResult, ResearchRun } from "../src/domain/research";

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
      budget: { maxToolCalls: 4 },
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
