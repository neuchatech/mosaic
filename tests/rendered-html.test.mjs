import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Mosaic assistant-first product surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Neuchatech MosAIc<\/title>/i);
  assert.match(html, /Ask MosAIc/);
  assert.match(html, /Add images/);
  assert.match(html, /Collections/);
  assert.match(html, /Layout: Space/);
  assert.match(html, /Images: Cropped/);
  assert.match(html, /lucide-arrow-up/);
  assert.match(html, /neuchatech\.ch/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});
