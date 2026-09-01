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
import { catalogMediaType, readCatalogMedia } from "./media";

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
  imageWorkflow: "native" | "local-clip";
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
  supportsImages?: boolean;
};

type ProviderEnvironment = Record<string, string | undefined>;
export type AiProviderCredentials = {
  apiKey: string | null;
  model: string | null;
  supportsImages?: boolean | null;
};

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
      imageWorkflow: "native",
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
      imageWorkflow: environment.MOSAIC_LOCAL_AI_VISION === "1" ? "native" : "local-clip",
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
      imageWorkflow: environment.MOSAIC_OPENROUTER_VISION === "1" || openRouter.supportsImages === true
        ? "native"
        : "local-clip",
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
  if (id === "codex") return { id, model, supportsImages: true };
  if (id === "local") {
    return {
      id,
      model,
      baseUrl: normalizedBaseUrl(environment.MOSAIC_LOCAL_AI_BASE_URL?.trim() || LOCAL_DEFAULT_BASE_URL, id),
      apiKey: environment.MOSAIC_LOCAL_AI_API_KEY?.trim() || undefined,
      supportsImages: environment.MOSAIC_LOCAL_AI_VISION === "1",
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
    supportsImages: environment.MOSAIC_OPENROUTER_VISION === "1" || openRouter.supportsImages === true,
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
  readMedia?: (itemId: string, fileName: string, maxBytes: number) => Promise<Buffer>;
};

const IMAGE_RESEARCH_TOOLS = new Set([
  "rank_workspace_by_visual_references",
  "inspect_workspace_item",
  "build_workspace_contact_sheet",
]);
const ACQUISITION_RESEARCH_TOOLS = new Set([
  "import_workspace_links",
  "import_browser_observations",
  "start_source_discovery",
  "get_source_discovery",
  "control_source_discovery",
  "refresh_workspace_items",
  "get_item_refresh",
  "control_item_refresh",
]);
const COLLECTION_WRITE_RESEARCH_TOOLS = new Set([
  "create_workspace_collection",
  "add_workspace_items_to_collection",
]);

function researchToolAllowed(run: ResearchRun, toolName: string, supportsImages: boolean): boolean {
  if (!supportsImages && (toolName === "inspect_workspace_item" || toolName === "build_workspace_contact_sheet")) return false;
  if (run.request.budget.maxImageInspections === 0 && IMAGE_RESEARCH_TOOLS.has(toolName)) return false;
  if (run.request.budget.maxAcquisitionJobs === 0 && ACQUISITION_RESEARCH_TOOLS.has(toolName)) return false;
  if (run.request.budget.maxCollectionWrites === 0 && COLLECTION_WRITE_RESEARCH_TOOLS.has(toolName)) return false;
  return true;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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
  const serialized = JSON.stringify(value, function omitForwardedImageBytes(key, entry) {
    if (key === "data" && this && typeof this === "object" && (this as { type?: unknown }).type === "image") {
      return "[image bytes omitted from text payload]";
    }
    return entry;
  });
  return serialized.length > 30_000 ? `${serialized.slice(0, 30_000)}…` : serialized;
}

function mcpImageParts(value: unknown): ChatContentPart[] {
  if (!value || typeof value !== "object") return [];
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry): ChatContentPart[] => {
    if (!entry || typeof entry !== "object") return [];
    const image = entry as { type?: unknown; data?: unknown; mimeType?: unknown };
    const mimeType = typeof image.mimeType === "string" ? image.mimeType : "";
    if (image.type !== "image" || typeof image.data !== "string" || image.data.length > 28_000_000) return [];
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return [];
    return [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${image.data}` } }];
  }).slice(0, 6);
}

async function attachedImageParts(
  run: ResearchRun,
  readMedia: NonNullable<OpenAiCompatibleAgentOptions["readMedia"]>,
): Promise<ChatContentPart[]> {
  const parts: ChatContentPart[] = [];
  for (const image of run.request.images.slice(0, 6)) {
    const match = /^\/api\/media\/([^/?#]+)\/([1-6]\.(?:jpg|png|webp))$/.exec(image.mediaPath);
    if (!match) throw new Error("Research images must use app-owned /api/media paths.");
    let itemId: string;
    try { itemId = decodeURIComponent(match[1]!); } catch { throw new Error("Invalid research media path."); }
    const bytes = await readMedia(itemId, match[2]!, 12 * 1024 * 1024);
    parts.push({
      type: "image_url",
      image_url: { url: `data:${catalogMediaType(match[2]!)};base64,${bytes.toString("base64")}` },
    });
  }
  return parts;
}

function validatedToolResult(value: unknown): ResearchAgentResult | null {
  if (!value || typeof value !== "object") return null;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  const wrapped = (structured as { result?: unknown }).result;
  if (!wrapped || typeof wrapped !== "object") return null;
  const data = (wrapped as { data?: unknown }).data;
  if (!data || typeof data !== "object" || (data as { valid?: unknown }).valid !== true) return null;
  const candidate = (data as { validatedResult?: unknown }).validatedResult;
  return candidate ? researchAgentResultSchema.parse(candidate) : null;
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
  const toolClient = await (options.createToolClient ?? createScopedToolClient)(input.run);
  const tools = (await toolClient.listTools()).tools
    .filter((tool) => researchToolAllowed(input.run, tool.name, options.provider.supportsImages === true))
    .map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
    }));
  const inputImages = options.provider.supportsImages
    ? await attachedImageParts(input.run, options.readMedia ?? readCatalogMedia)
    : [];
  const messages: ChatMessage[] = [
    { role: "system", content: options.instruction },
    {
      role: "user",
      content: inputImages.length ? [
        {
          type: "text",
          text: "Use the available MosAIc tools autonomously. The images below are explicit user-provided references for this request. Return only the validated research-result JSON when finished.",
        },
        ...inputImages,
      ] : "Use the available MosAIc tools autonomously. Return only the validated research-result JSON when finished.",
    },
  ];
  let toolCalls = 0;
  let validationAttempts = 0;
  let forceFinalAnswer = false;
  let finalAnswerAttempted = false;
  const maxRounds = Math.min(164, input.run.request.budget.maxToolCalls + 8);
  const startedAt = Date.now();
  const hardDeadline = startedAt + input.run.request.budget.maxDurationMs;
  const finalizationReserveMs = Math.min(30_000, Math.max(10_000, Math.floor(input.run.request.budget.maxDurationMs * .15)));
  const researchDeadline = hardDeadline - finalizationReserveMs;
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      if (input.signal.aborted) throw new DOMException("Research run cancelled", "AbortError");
      const finalOnly = forceFinalAnswer
        || toolCalls >= input.run.request.budget.maxToolCalls
        || round === maxRounds - 1
        || Date.now() >= researchDeadline;
      if (finalOnly) {
        if (finalAnswerAttempted) throw new Error("The AI provider did not produce a usable final result within the research budget.");
        finalAnswerAttempted = true;
        messages.push({
          role: "user",
          content: "The research phase is over and no more tool calls are allowed. Return the best truthful research-result JSON now using only confirmed evidence. A partial or needs_input outcome is preferable to inventing facts. Do not call a tool and do not include Markdown.",
        });
        input.onEvent({ type: "progress", message: "Tool budget reached; preparing the final answer" });
      }
      const requestDeadline = finalOnly ? hardDeadline : researchDeadline;
      const remainingMs = requestDeadline - Date.now();
      if (remainingMs <= 0) throw new Error(`Research reached its ${Math.round(input.run.request.budget.maxDurationMs / 1_000)} second budget.`);
      const turnSignal = AbortSignal.any([input.signal, AbortSignal.timeout(remainingMs)]);
      let response: Response;
      try {
        response = await requestFetch(`${options.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.provider.apiKey ? { authorization: `Bearer ${options.provider.apiKey}` } : {}),
          ...options.provider.headers,
        },
        body: JSON.stringify({
          model: options.provider.model,
          messages,
          ...(!finalOnly ? { tools, tool_choice: round === 0 ? "required" : "auto" } : {}),
          temperature: 0.2,
          max_tokens: finalOnly
            ? input.run.request.reasoningEffort === "low" ? 1_024 : 4_096
            : round === 0
            ? 512
            : input.run.request.reasoningEffort === "low" ? 1_024 : 4_096,
        }),
        signal: turnSignal,
        redirect: options.provider.id === "local" ? "error" : "follow",
        });
      } catch (error) {
        if (!finalOnly && !input.signal.aborted && turnSignal.aborted) {
          forceFinalAnswer = true;
          input.onEvent({ type: "progress", message: "Research time reached; preparing the final answer" });
          continue;
        }
        throw error;
      }
      const completion = await response.json() as ChatCompletion;
      if (!response.ok) throw new Error(completion.error?.message || `${options.provider.id} returned HTTP ${response.status}.`);
      const message = completion.choices?.[0]?.message;
      if (!message) throw new Error(`${options.provider.id} returned no assistant message.`);
      const content = assistantText(message);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({ role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length) {
        const visualEvidence: ChatContentPart[] = [];
        for (const call of calls) {
          if (toolCalls >= input.run.request.budget.maxToolCalls) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Tool-call budget exhausted at ${input.run.request.budget.maxToolCalls}. No tool was executed; return the best truthful final JSON from confirmed evidence.`,
            });
            forceFinalAnswer = true;
            continue;
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
          if (options.provider.supportsImages) visualEvidence.push(...mcpImageParts(result));
          input.onEvent({ type: "tool-result", message: `Completed ${call.function.name}`, data: { tool: call.function.name } });
          if (call.function.name === "validate_research_result") {
            const parsed = validatedToolResult(result);
            if (parsed) {
              return {
                ...parsed,
                metrics: {
                  ...parsed.metrics,
                  toolCalls: Math.min(input.run.request.budget.maxToolCalls, Math.max(parsed.metrics.toolCalls, toolCalls)),
                },
              };
            }
          }
        }
        if (visualEvidence.length) {
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Native visual evidence returned by the MosAIc tools:" },
              ...visualEvidence.slice(0, 6),
            ],
          });
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
          if (finalOnly || validationAttempts >= 3) throw error;
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
