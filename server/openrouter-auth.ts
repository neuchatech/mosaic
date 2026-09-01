import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_API = `${OPENROUTER_ORIGIN}/api/v1`;
const FLOW_TTL_MS = 10 * 60 * 1_000;
const MODEL_CACHE_MS = 5 * 60 * 1_000;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type OpenRouterCredentials = {
  apiKey: string | null;
  model: string | null;
  connectedAt: string | null;
  supportsImages: boolean | null;
};

export type OpenRouterModel = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: string | null;
  completionPrice: string | null;
  supportedParameters: string[];
  inputModalities: string[];
  supportsImages: boolean;
};

type StoredOpenRouterCredentials = {
  version: 1;
  apiKey: string;
  model: string | null;
  connectedAt: string;
  supportsImages?: boolean | null;
};

type PendingFlow = {
  verifier: string;
  callbackUrl: string;
  expiresAt: number;
};

function compactJson(response: Response, limit = 200_000): Promise<unknown> {
  return response.text().then((text) => {
    if (text.length > limit) throw new Error("OpenRouter returned an unexpectedly large response.");
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("OpenRouter returned invalid JSON."); }
  });
}

function safeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 240 && /^[a-zA-Z0-9._~:/+-]+$/.test(trimmed) ? trimmed : null;
}

function loopbackCallback(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OpenRouter callback must be an HTTP(S) localhost URL.");
  }
  return url;
}

export class OpenRouterCredentialStore {
  private value: OpenRouterCredentials;

  constructor(
    private readonly filePath = resolve(projectRoot, "data/secrets/openrouter.json"),
  ) {
    this.value = this.load();
  }

  snapshot(): OpenRouterCredentials {
    return { ...this.value };
  }

  private load(): OpenRouterCredentials {
    if (!existsSync(this.filePath)) return { apiKey: null, model: null, connectedAt: null, supportsImages: null };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredOpenRouterCredentials>;
      if (parsed.version !== 1 || typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) throw new Error();
      return {
        apiKey: parsed.apiKey.trim(),
        model: safeModelId(parsed.model),
        connectedAt: typeof parsed.connectedAt === "string" ? parsed.connectedAt : null,
        supportsImages: typeof parsed.supportsImages === "boolean" ? parsed.supportsImages : null,
      };
    } catch {
      return { apiKey: null, model: null, connectedAt: null, supportsImages: null };
    }
  }

  async save(next: OpenRouterCredentials): Promise<void> {
    if (!next.apiKey?.trim()) throw new Error("An OpenRouter API key is required.");
    const directory = dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const wire: StoredOpenRouterCredentials = {
      version: 1,
      apiKey: next.apiKey.trim(),
      model: safeModelId(next.model),
      connectedAt: next.connectedAt ?? new Date().toISOString(),
      supportsImages: typeof next.supportsImages === "boolean" ? next.supportsImages : null,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    try {
      await writeFile(temporary, `${JSON.stringify(wire, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      this.value = {
        apiKey: wire.apiKey,
        model: wire.model,
        connectedAt: wire.connectedAt,
        supportsImages: wire.supportsImages ?? null,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    this.value = { apiKey: null, model: null, connectedAt: null, supportsImages: null };
    await rm(this.filePath, { force: true });
  }
}

export type OpenRouterConnectionOptions = {
  store?: OpenRouterCredentialStore;
  fetch?: typeof fetch;
  now?: () => Date;
  environment?: Record<string, string | undefined>;
};

export class OpenRouterConnectionService {
  readonly store: OpenRouterCredentialStore;
  private readonly requestFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly environment: Record<string, string | undefined>;
  private readonly pending = new Map<string, PendingFlow>();
  private modelCache: { key: string; expiresAt: number; models: OpenRouterModel[] } | null = null;

  constructor(options: OpenRouterConnectionOptions = {}) {
    this.store = options.store ?? new OpenRouterCredentialStore();
    this.requestFetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? process.env;
  }

  credentials(): OpenRouterCredentials {
    return this.store.snapshot();
  }

  status(): { connected: boolean; managedBy: "environment" | "local" | "none"; connectedAt: string | null } {
    const local = this.store.snapshot();
    if (this.environment.OPENROUTER_API_KEY?.trim()) {
      return { connected: true, managedBy: "environment", connectedAt: null };
    }
    return {
      connected: Boolean(local.apiKey),
      managedBy: local.apiKey ? "local" : "none",
      connectedAt: local.connectedAt,
    };
  }

  begin(callback: string): { authorizationUrl: string; state: string; expiresAt: string } {
    const callbackUrl = loopbackCallback(callback);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = this.now().getTime() + FLOW_TTL_MS;
    this.pending.set(state, { verifier, callbackUrl: callbackUrl.toString(), expiresAt });
    const authorization = new URL("/auth", OPENROUTER_ORIGIN);
    authorization.searchParams.set("callback_url", callbackUrl.toString());
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("key_label", "Neuchatech MosAIc");
    return { authorizationUrl: authorization.toString(), state, expiresAt: new Date(expiresAt).toISOString() };
  }

  async complete(input: { state: string; code: string }): Promise<void> {
    const flow = this.pending.get(input.state);
    this.pending.delete(input.state);
    if (!flow || flow.expiresAt < this.now().getTime()) throw new Error("OpenRouter connection expired. Start again.");
    if (!input.code.trim() || input.code.length > 2_000) throw new Error("Invalid OpenRouter authorization code.");
    const response = await this.requestFetch(`${OPENROUTER_API}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code.trim(),
        code_verifier: flow.verifier,
        code_challenge_method: "S256",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await compactJson(response) as { key?: unknown; error?: { message?: unknown }; message?: unknown };
    if (!response.ok || typeof payload.key !== "string" || !payload.key.trim()) {
      const message = typeof payload.error?.message === "string"
        ? payload.error.message
        : typeof payload.message === "string" ? payload.message : `OpenRouter returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    const current = this.store.snapshot();
    await this.store.save({
      apiKey: payload.key,
      model: current.model,
      connectedAt: this.now().toISOString(),
      supportsImages: current.supportsImages,
    });
    this.modelCache = null;
  }

  private effectiveKey(): string {
    const key = this.environment.OPENROUTER_API_KEY?.trim() || this.store.snapshot().apiKey;
    if (!key) throw new Error("OpenRouter is not connected.");
    return key;
  }

  async models(): Promise<OpenRouterModel[]> {
    const key = this.effectiveKey();
    const keyHash = createHash("sha256").update(key).digest("hex");
    if (this.modelCache && this.modelCache.key === keyHash && this.modelCache.expiresAt > this.now().getTime()) {
      return this.modelCache.models;
    }
    const response = await this.requestFetch(`${OPENROUTER_API}/models?supported_parameters=tools&sort=most-popular`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await compactJson(response, 2_000_000) as { data?: unknown; error?: { message?: unknown } };
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(typeof payload.error?.message === "string" ? payload.error.message : `OpenRouter returned HTTP ${response.status}.`);
    }
    const models = payload.data.flatMap((entry): OpenRouterModel[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const id = safeModelId(record.id);
      const supported = Array.isArray(record.supported_parameters)
        ? record.supported_parameters.filter((item): item is string => typeof item === "string")
        : [];
      if (!id || !supported.includes("tools")) return [];
      const pricing = record.pricing && typeof record.pricing === "object" ? record.pricing as Record<string, unknown> : {};
      const architecture = record.architecture && typeof record.architecture === "object"
        ? record.architecture as Record<string, unknown>
        : {};
      const inputModalities = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
        : [];
      return [{
        id,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
        contextLength: typeof record.context_length === "number" && Number.isFinite(record.context_length) ? record.context_length : null,
        promptPrice: typeof pricing.prompt === "string" ? pricing.prompt : null,
        completionPrice: typeof pricing.completion === "string" ? pricing.completion : null,
        supportedParameters: supported,
        inputModalities,
        supportsImages: inputModalities.includes("image"),
      }];
    });
    const current = this.store.snapshot();
    const currentModel = models.find((model) => model.id === current.model);
    if (!this.environment.OPENROUTER_API_KEY?.trim() && current.apiKey && currentModel
      && current.supportsImages !== currentModel.supportsImages) {
      await this.store.save({ ...current, supportsImages: currentModel.supportsImages });
    }
    this.modelCache = { key: keyHash, expiresAt: this.now().getTime() + MODEL_CACHE_MS, models };
    return models;
  }

  async selectModel(model: string): Promise<void> {
    const id = safeModelId(model);
    if (!id) throw new Error("Invalid OpenRouter model id.");
    const models = await this.models();
    const selected = models.find((candidate) => candidate.id === id);
    if (!selected) throw new Error("Choose an OpenRouter model that supports tools.");
    if (this.environment.OPENROUTER_API_KEY?.trim() || this.environment.MOSAIC_OPENROUTER_MODEL?.trim()) {
      throw new Error("OpenRouter is managed by environment variables. Set MOSAIC_OPENROUTER_MODEL and restart MosAIc.");
    }
    const current = this.store.snapshot();
    const key = current.apiKey;
    if (!key) throw new Error("OpenRouter is not connected.");
    await this.store.save({
      apiKey: key,
      model: id,
      connectedAt: current.connectedAt ?? this.now().toISOString(),
      supportsImages: selected.supportsImages,
    });
  }

  async disconnect(): Promise<void> {
    await this.store.clear();
    this.modelCache = null;
  }
}
