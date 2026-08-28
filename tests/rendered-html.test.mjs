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

test("server-renders the Wardrobe Atlas product surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Wardrobe Atlas<\/title>/i);
  assert.match(html, /Carte de style/);
  assert.match(html, /Décris un filtre ou colle un mood board/);
  assert.match(html, /Planche \+ détail/);
  assert.match(html, /PCA compacte/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});
