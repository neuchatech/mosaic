import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { extractGenericJsonLdProduct } from "../collector/adapters/generic-jsonld";
import { loadProductImage } from "../mcp/contact-sheet";
import { fetchPublicBytes, setPublicNetworkTestHooksForTests } from "../server/public-html";
import { catalogMediaPath, persistCatalogImages } from "../server/media";
import {
  isPublicIpAddress,
  normalizePublicHttpsUrl,
  resolvePublicHostname,
  type PublicHostResolver,
} from "../server/public-network";
import { productSchema, type Product } from "../src/domain/catalog";

const publicResolver: PublicHostResolver = async () => [{ address: "8.8.8.8", family: 4 }];

function productWithImage(
  image: string,
  kind: Product["kind"] = "shop",
  id = `security-${Math.random().toString(36).slice(2)}`,
): Product {
  const now = "2026-08-30T12:00:00.000Z";
  return productSchema.parse({
    id,
    kind,
    source: "security-test",
    sourceId: id,
    url: "https://shop.example.com/products/security-test",
    brand: "Security Test",
    name: "Security Test Item",
    price: null,
    images: [image],
    importedAt: now,
    updatedAt: now,
  });
}

async function withNetworkHooks<T>(
  hooks: Parameters<typeof setPublicNetworkTestHooksForTests>[0],
  action: () => Promise<T>,
): Promise<T> {
  setPublicNetworkTestHooksForTests(hooks);
  try {
    return await action();
  } finally {
    setPublicNetworkTestHooksForTests(null);
  }
}

test("public URL validation resolves safe HTTPS relatives and rejects local schemes and hosts", () => {
  assert.equal(
    normalizePublicHttpsUrl("../gallery/item.webp", "https://shop.example.com/products/123"),
    "https://shop.example.com/gallery/item.webp",
  );
  for (const value of [
    "file:///etc/passwd",
    "data:image/png;base64,YQ==",
    "http://shop.example.com/image.jpg",
    "https://user:password@shop.example.com/image.jpg",
    "https://127.0.0.1/image.jpg",
    "https://localhost/image.jpg",
  ]) assert.equal(normalizePublicHttpsUrl(value), null, value);
});

test("public address validation rejects private, local, transition, and mixed DNS answers", async () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.168.1.1", "::1", "fc00::1", "fe80::1",
    "::ffff:127.0.0.1", "2002:7f00:1::",
  ]) assert.equal(isPublicIpAddress(address), false, address);
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);

  await assert.rejects(
    resolvePublicHostname("shop.example.com", async () => [{ address: "10.0.0.5", family: 4 }]),
    /non-public address/i,
  );
  await assert.rejects(
    resolvePublicHostname("shop.example.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public address/i,
  );
});

test("public fetch blocks loopback, private redirects, DNS rebinding, and oversized streams", async (t) => {
  await t.test("rejects a loopback URL before DNS or transport", async () => {
    let resolverCalls = 0;
    let fetchCalls = 0;
    await withNetworkHooks({
      resolver: async () => { resolverCalls += 1; return [{ address: "8.8.8.8", family: 4 }]; },
      fetch: async () => { fetchCalls += 1; return new Response("unexpected"); },
    }, async () => {
      await assert.rejects(fetchPublicBytes("https://127.0.0.1/secret", {
        signal: new AbortController().signal,
      }), /public HTTPS URL/i);
    });
    assert.equal(resolverCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test("rejects a redirect to a private target", async () => {
    let fetchCalls = 0;
    await withNetworkHooks({
      resolver: publicResolver,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
      },
    }, async () => {
      await assert.rejects(fetchPublicBytes("https://shop.example.com/start", {
        signal: new AbortController().signal,
      }), /redirect requires a credential-free public HTTPS URL/i);
    });
    assert.equal(fetchCalls, 1);
  });

  await t.test("rechecks DNS on redirects and stops a public-to-private rebinding", async () => {
    let resolverCalls = 0;
    let fetchCalls = 0;
    await withNetworkHooks({
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [{ address: "8.8.8.8", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 302, headers: { location: "/next" } });
      },
    }, async () => {
      await assert.rejects(fetchPublicBytes("https://shop.example.com/start", {
        signal: new AbortController().signal,
      }), /non-public address/i);
    });
    assert.equal(resolverCalls, 2);
    assert.equal(fetchCalls, 1);
  });

  await t.test("aborts a streamed body above the byte cap", async () => {
    await withNetworkHooks({
      resolver: publicResolver,
      fetch: async () => new Response(Buffer.from("12345"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    }, async () => {
      await assert.rejects(fetchPublicBytes("https://shop.example.com/resource", {
        signal: new AbortController().signal,
        maxBytes: 4,
      }), /exceeded 4 bytes/i);
    });
  });
});

test("generic Product JSON-LD keeps only resolved public HTTPS images", () => {
  const html = `<!doctype html><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    sku: "SAFE-1",
    name: "Safe product",
    image: [
      "../gallery/main.jpg",
      { contentUrl: "/gallery/second.webp" },
      "file:///etc/passwd",
      "http://cdn.example.com/insecure.jpg",
      "https://127.0.0.1/private.jpg",
      "data:image/png;base64,YQ==",
    ],
    offers: { price: "40", priceCurrency: "CHF", availability: "https://schema.org/InStock" },
  })}</script>`;
  const product = extractGenericJsonLdProduct(html, "https://shop.example.com/products/item");
  assert.deepEqual(product?.images, [
    "https://shop.example.com/gallery/main.jpg",
    "https://shop.example.com/gallery/second.webp",
  ]);
});

test("contact-sheet image loading accepts only item-owned media for references", async () => {
  const id = `owned-security-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = Buffer.from("owned-reference-image");
  const stored = await persistCatalogImages(id, [`data:image/png;base64,${bytes.toString("base64")}`]);
  const mediaDirectory = dirname(catalogMediaPath(id, "1.png"));
  try {
    assert.deepEqual(await loadProductImage(productWithImage(stored[0]!, "reference", id)), bytes);
    await assert.rejects(
      loadProductImage(productWithImage("file:///etc/passwd", "reference", id)),
      /app-owned catalog media/i,
    );
    await assert.rejects(
      loadProductImage(productWithImage(`/api/media/${id}/../1.png`, "reference", id)),
      /app-owned catalog media/i,
    );
    await assert.rejects(
      loadProductImage(productWithImage("/api/media/another-item/1.png", "reference", id)),
      /does not belong/i,
    );
    await assert.rejects(
      loadProductImage(productWithImage("https://cdn.example.com/reference.jpg", "owned", id)),
      /app-owned catalog media/i,
    );
  } finally {
    rmSync(mediaDirectory, { recursive: true, force: true });
  }
});

test("remote personal images are fetched safely and copied into app-owned media", async () => {
  const id = `remote-security-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = Buffer.from("remote-jpeg-image");
  const mediaDirectory = dirname(catalogMediaPath(id, "1.jpg"));
  try {
    const stored = await withNetworkHooks({
      resolver: publicResolver,
      fetch: async () => new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    }, () => persistCatalogImages(id, ["https://cdn.example.com/reference.jpg"]));
    assert.deepEqual(stored, [`/api/media/${id}/1.jpg`]);
    assert.deepEqual(await loadProductImage(productWithImage(stored[0]!, "reference", id)), bytes);
  } finally {
    rmSync(mediaDirectory, { recursive: true, force: true });
  }

  await assert.rejects(
    persistCatalogImages(`${id}-file`, ["file:///etc/passwd"]),
    /unsupported image/i,
  );
  await assert.rejects(
    persistCatalogImages("../escape", ["data:image/png;base64,YQ=="]),
    /invalid catalog media path/i,
  );
});

test("contact-sheet shop images reject local paths and private DNS without transport", async () => {
  for (const image of ["file:///etc/passwd", "/../../etc/passwd", "https://127.0.0.1/image.jpg"]) {
    await assert.rejects(loadProductImage(productWithImage(image)), /public HTTPS URL/i);
  }

  let fetchCalls = 0;
  await withNetworkHooks({
    resolver: async () => [{ address: "192.168.1.50", family: 4 }],
    fetch: async () => { fetchCalls += 1; return new Response("unexpected"); },
  }, async () => {
    await assert.rejects(
      loadProductImage(productWithImage(`https://cdn.example.com/private-${Date.now()}.jpg`)),
      /non-public address/i,
    );
  });
  assert.equal(fetchCalls, 0);
});
