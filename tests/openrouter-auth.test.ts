import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createApp } from "../server/app";
import { OpenRouterConnectionService, OpenRouterCredentialStore } from "../server/openrouter-auth";
import { ResearchAgentService } from "../server/research-agent";
import { CatalogRepository } from "../server/repository";

test("OpenRouter PKCE connects, exposes tool models, persists the selection, and never returns the key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosaic-openrouter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretPath = join(root, "secrets", "openrouter.json");
  const requests: Array<{ url: string; body: unknown }> = [];
  const requestFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/auth/keys")) {
      return new Response(JSON.stringify({ key: "sk-or-user-secret" }), { status: 200 });
    }
    if (url.includes("/models?")) {
      return new Response(JSON.stringify({ data: [
        { id: "anthropic/claude-tools", name: "Claude Tools", context_length: 200_000, supported_parameters: ["tools", "tool_choice"], pricing: { prompt: "0.1", completion: "0.2" } },
        { id: "vendor/no-tools", name: "No tools", supported_parameters: ["temperature"] },
      ] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const openRouter = new OpenRouterConnectionService({
    store: new OpenRouterCredentialStore(secretPath),
    fetch: requestFetch,
    environment: {},
  });
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  t.after(() => database.close());
  const repository = new CatalogRepository(database);
  const research = new ResearchAgentService(repository, { environment: { CODEX_CLI_PATH: "/usr/bin/true" }, openRouter });
  const app = createApp(repository, undefined, undefined, { researchAgent: research });

  const begin = await app.request("/api/ai/openrouter/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callbackUrl: "http://localhost:3000/auth/openrouter" }),
  });
  assert.equal(begin.status, 200);
  const beginPayload = await begin.json() as { authorizationUrl: string; state: string };
  const authorizationUrl = new URL(beginPayload.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://openrouter.ai");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const callbackUrl = new URL(authorizationUrl.searchParams.get("callback_url")!);
  assert.equal(callbackUrl.searchParams.has("mosaic_state"), false);
  const state = beginPayload.state;
  assert.ok(state);

  const callback = await app.request("/api/ai/openrouter/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, code: "one-time-code" }),
  });
  assert.equal(callback.status, 200);
  assert.equal(JSON.stringify(await callback.json()).includes("sk-or-user-secret"), false);
  assert.equal((requests[0]?.body as { code_challenge_method: string }).code_challenge_method, "S256");

  const models = await app.request("/api/ai/openrouter/models");
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json() as { models: Array<{ id: string }> }).models.map((model) => model.id), ["anthropic/claude-tools"]);

  const selected = await app.request("/api/ai/openrouter/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-tools" }),
  });
  assert.equal(selected.status, 200);
  const selectedWire = JSON.stringify(await selected.json());
  assert.equal(selectedWire.includes("sk-or-user-secret"), false);
  assert.equal(selectedWire.includes("anthropic/claude-tools"), true);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(secretPath, "utf8")).includes("sk-or-user-secret"), true);

  const replay = await app.request("/api/ai/openrouter/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, code: "one-time-code" }),
  });
  assert.equal(replay.status, 409);

  const disconnected = await app.request("/api/ai/openrouter/connection", { method: "DELETE" });
  assert.equal(disconnected.status, 200);
  assert.equal(openRouter.status().connected, false);
});

test("OpenRouter only accepts localhost callbacks", () => {
  const connection = new OpenRouterConnectionService({ environment: {} });
  assert.throws(() => connection.begin("https://example.com/auth/openrouter"), /localhost/);
  assert.throws(() => connection.begin("file:///tmp/callback"), /localhost/);
});
