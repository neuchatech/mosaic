import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  researchAgentResultSchema,
  type ResearchAgentResult,
  type ResearchAiProvider,
  type ResearchRun,
  type ResearchRunEvent,
} from "../src/domain/research";
import { codexExecutable } from "./codex-bridge";

export type AiProviderId = Exclude<ResearchAiProvider, "auto">;

export type AiProviderView = {
  id: AiProviderId;
  label: string;
  configured: boolean;
  local: boolean;
  model: string | null;
  detail: string;
  connected: boolean;
  managedBy: "environment" | "local" | "none";
};

export type AiProviderCatalog = {
  defaultProvider: AiProviderId;
  providers: AiProviderView[];
};

export type ResolvedAiProvider = {
  id: AiProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

type ProviderEnvironment = Record<string, string | undefined>;
export type AiProviderCredentials = { apiKey: string | null; model: string | null };

const LOCAL_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizedBaseUrl(value: string, provider: AiProviderId): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error(`${provider} AI base URL cannot contain credentials.`);
  if (provider === "local") {
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
    if (!loopback || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error("Local AI must use an HTTP(S) loopback URL.");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`${provider} AI requires HTTPS.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function envModel(environment: ProviderEnvironment, provider: AiProviderId, credentials?: AiProviderCredentials): string | null {
  if (provider === "codex") return environment.MOSAIC_CODEX_MODEL?.trim() || "gpt-5.6-luna";
  if (provider === "local") return environment.MOSAIC_LOCAL_AI_MODEL?.trim() || null;
  return environment.MOSAIC_OPENROUTER_MODEL?.trim() || credentials?.model || null;
}

function codexIsAvailable(environment: ProviderEnvironment): boolean {
  if (environment.MOSAIC_CODEX_ENABLED === "0") return false;
  const executable = environment.CODEX_CLI_PATH?.trim() || codexExecutable();
  if (executable.includes("/")) return existsSync(executable);
  return (environment.PATH ?? process.env.PATH ?? "").split(":")
    .some((directory) => directory && existsSync(resolve(directory, executable)));
}

export function aiProviderCatalog(
  environment: ProviderEnvironment = process.env,
  openRouter: AiProviderCredentials = { apiKey: null, model: null },
): AiProviderCatalog {
  const requestedDefault = environment.MOSAIC_AI_PROVIDER?.trim().toLowerCase();
  const providers: AiProviderView[] = [
    {
      id: "codex",
      label: "Codex",
      configured: codexIsAvailable(environment),
      local: true,
      model: envModel(environment, "codex"),
      detail: "Codex CLI with the private MosAIc MCP",
      connected: codexIsAvailable(environment),
      managedBy: "environment",
    },
    {
      id: "local",
      label: "Local API",
      configured: Boolean(envModel(environment, "local")),
      local: true,
      model: envModel(environment, "local"),
      detail: "LM Studio, Ollama, vLLM, or another OpenAI-compatible server",
      connected: Boolean(envModel(environment, "local")),
      managedBy: envModel(environment, "local") ? "environment" : "none",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      configured: Boolean((environment.OPENROUTER_API_KEY?.trim() || openRouter.apiKey) && envModel(environment, "openrouter", openRouter)),
      local: false,
      model: envModel(environment, "openrouter", openRouter),
      detail: "OpenRouter model with MosAIc's local tools",
      connected: Boolean(environment.OPENROUTER_API_KEY?.trim() || openRouter.apiKey),
      managedBy: environment.OPENROUTER_API_KEY?.trim() ? "environment" : openRouter.apiKey ? "local" : "none",
    },
  ];
  const requested = providers.find((provider) => provider.id === requestedDefault && provider.configured);
  const fallback = requested ?? providers.find((provider) => provider.configured) ?? providers[0]!;
  return { defaultProvider: fallback.id, providers };
}

export function resolveAiProvider(
  requested: ResearchAiProvider,
  modelOverride: string | null,
  environment: ProviderEnvironment = process.env,
  openRouter: AiProviderCredentials = { apiKey: null, model: null },
): ResolvedAiProvider {
  const catalog = aiProviderCatalog(environment, openRouter);
  const id = requested === "auto" ? catalog.defaultProvider : requested;
  const view = catalog.providers.find((provider) => provider.id === id);
  if (!view?.configured) throw new Error(`${view?.label ?? id} is not configured.`);
  const model = modelOverride?.trim() || view.model;
  if (!model) throw new Error(`${view.label} needs a model.`);
  if (id === "codex") return { id, model };
  if (id === "local") {
    return {
      id,
      model,
      baseUrl: normalizedBaseUrl(environment.MOSAIC_LOCAL_AI_BASE_URL?.trim() || LOCAL_DEFAULT_BASE_URL, id),
      apiKey: environment.MOSAIC_LOCAL_AI_API_KEY?.trim() || undefined,
    };
  }
  return {
    id,
    model,
    baseUrl: normalizedBaseUrl(environment.MOSAIC_OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE_URL, id),
    apiKey: environment.OPENROUTER_API_KEY?.trim() || openRouter.apiKey || undefined,
    headers: {
      ...(environment.MOSAIC_OPENROUTER_SITE_URL?.trim()
        ? { "HTTP-Referer": environment.MOSAIC_OPENROUTER_SITE_URL.trim() }
        : {}),
      "X-OpenRouter-Title": environment.MOSAIC_OPENROUTER_APP_NAME?.trim() || "Neuchatech MosAIc",
    },
  };
}

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ResearchToolClient = {
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export type OpenAiCompatibleAgentOptions = {
  provider: ResolvedAiProvider;
  instruction: string;
  fetch?: typeof fetch;
  createToolClient?: (run: ResearchRun) => Promise<ResearchToolClient>;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
  error?: { message?: string };
};

function toolResultText(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 30_000 ? `${serialized.slice(0, 30_000)}…` : serialized;
}

function assistantText(value: ChatCompletion["choices"] extends Array<infer T> | undefined
  ? T extends { message?: infer M } ? M : never : never): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
  }).join("\n");
  return "";
}

function parseStructuredResult(text: string): ResearchAgentResult {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model did not return a JSON research result.");
  const wire = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
  if (Array.isArray(wire.filters)) {
    wire.filters = wire.filters.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const record = entry as Record<string, unknown>;
      if (!record.filter || typeof record.filter !== "object") return entry;
      const filter = { ...record.filter as Record<string, unknown> };
      if (filter.sort === null) delete filter.sort;
      return { ...record, filter };
    });
  }
  return researchAgentResultSchema.parse(wire);
}

async function createScopedToolClient(run: ResearchRun): Promise<ResearchToolClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/index.ts"],
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.WARDROBE_DB_PATH ? { WARDROBE_DB_PATH: process.env.WARDROBE_DB_PATH } : {}),
      ...(process.env.MOSAIC_API_URL ? { MOSAIC_API_URL: process.env.MOSAIC_API_URL } : {}),
      MOSAIC_RESEARCH_RUN_ID: run.id,
      MOSAIC_RESEARCH_WORKSPACE_ID: run.workspaceId,
      MOSAIC_RESEARCH_BUDGET_JSON: JSON.stringify(run.request.budget),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mosaic-openai-compatible-agent", version: "1.0.0" });
  await client.connect(transport);
  return client as unknown as ResearchToolClient;
}

export async function runOpenAiCompatibleResearchAgent(
  input: {
    run: ResearchRun;
    signal: AbortSignal;
    onEvent(event: { type: "tool-call" | "tool-result" | "message" | "progress"; message?: string; data?: ResearchRunEvent["data"] }): void;
  },
  options: OpenAiCompatibleAgentOptions,
): Promise<ResearchAgentResult> {
  const requestFetch = options.fetch ?? fetch;
  const timeoutSignal = AbortSignal.timeout(input.run.request.budget.maxDurationMs);
  const requestSignal = AbortSignal.any([input.signal, timeoutSignal]);
  const toolClient = await (options.createToolClient ?? createScopedToolClient)(input.run);
  const tools = (await toolClient.listTools()).tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: options.instruction },
    {
      role: "user",
      content: "Use the available MosAIc tools autonomously. Return only the validated research-result JSON when finished.",
    },
  ];
  let toolCalls = 0;
  let validationAttempts = 0;
  const maxRounds = Math.min(164, input.run.request.budget.maxToolCalls + 8);
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      if (requestSignal.aborted) {
        if (input.signal.aborted) throw new DOMException("Research run cancelled", "AbortError");
        throw new Error(`Research reached its ${Math.round(input.run.request.budget.maxDurationMs / 1_000)} second budget.`);
      }
      const response = await requestFetch(`${options.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.provider.apiKey ? { authorization: `Bearer ${options.provider.apiKey}` } : {}),
          ...options.provider.headers,
        },
        body: JSON.stringify({
          model: options.provider.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
        }),
        signal: requestSignal,
        redirect: options.provider.id === "local" ? "error" : "follow",
      });
      const completion = await response.json() as ChatCompletion;
      if (!response.ok) throw new Error(completion.error?.message || `${options.provider.id} returned HTTP ${response.status}.`);
      const message = completion.choices?.[0]?.message;
      if (!message) throw new Error(`${options.provider.id} returned no assistant message.`);
      const content = assistantText(message);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({ role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length) {
        for (const call of calls) {
          if (toolCalls >= input.run.request.budget.maxToolCalls) {
            throw new Error(`Research reached its ${input.run.request.budget.maxToolCalls} tool-call budget.`);
          }
          let args: Record<string, unknown> | null = null;
          try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
          catch { /* Return a tool error so the model can repair its own call. */ }
          toolCalls += 1;
          input.onEvent({ type: "tool-call", message: `Using ${call.function.name}`, data: { tool: call.function.name } });
          let result: unknown;
          if (!args) {
            result = { isError: true, error: "Tool arguments were not valid JSON. Retry with a JSON object." };
          } else {
            try {
              result = await toolClient.callTool({ name: call.function.name, arguments: args });
            } catch (error) {
              result = { isError: true, error: error instanceof Error ? error.message : String(error) };
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText(result) });
          input.onEvent({ type: "tool-result", message: `Completed ${call.function.name}`, data: { tool: call.function.name } });
        }
        continue;
      }
      if (content) {
        try {
          const parsed = parseStructuredResult(content);
          return {
            ...parsed,
            metrics: {
              ...parsed.metrics,
              toolCalls: Math.min(input.run.request.budget.maxToolCalls, Math.max(parsed.metrics.toolCalls, toolCalls)),
            },
          };
        } catch (error) {
          validationAttempts += 1;
          if (validationAttempts >= 3) throw error;
          messages.push({
            role: "user",
            content: `Your final answer was not valid research-result JSON: ${error instanceof Error ? error.message : String(error)}. Correct it, call validate_research_result if needed, and return only the corrected JSON.`,
          });
          input.onEvent({ type: "progress", message: `Correcting structured result (${validationAttempts}/3)` });
          continue;
        }
      }
      throw new Error(`${options.provider.id} stopped without a result or tool call.`);
    }
    throw new Error("The AI provider exceeded the bounded agent loop without a final result.");
  } finally {
    await toolClient.close().catch(() => undefined);
  }
}
