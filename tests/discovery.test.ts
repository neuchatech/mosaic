import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  aliExpressSourceId,
  buildAliExpressDiscoveryTargets,
  canonicalAliExpressProductUrl,
  classifyAliExpressAccessBlock,
  normalizeAliExpressDetail,
  normalizeAliExpressListingCard,
  parseAliExpressChfPrice,
} from "../collector/adapters/aliexpress";
import {
  aboutYouSizesFromText,
  aboutYouSourceIdFromUrl,
  buildAboutYouDiscoveryTargets,
  normalizeAboutYouListingCard,
  aboutYouAdapter,
} from "../collector/adapters/aboutyou";
import { extractGenericJsonLdProduct } from "../collector/adapters/generic-jsonld";
import {
  buildZalandoDiscoveryTargets,
  extractZalandoDetailHtml,
  extractZalandoListingHtml,
  zalandoSourceIdFromUrl,
} from "../collector/adapters/zalando";
import { adapterFor, discoveryAdapterFor } from "../collector/registry";
import type { DiscoveryIntent, RawProduct } from "../collector/types";
import {
  DiscoveryBlockedError,
  DiscoveryCancelledError,
  DiscoveryService,
  FileDiscoveryJobStore,
  PlaywrightDiscoveryFetcher,
  type DiscoveryFetcher,
  type DiscoveryJobSnapshot,
  type DiscoveryJobStore,
} from "../server/discovery";
import { setPublicNetworkTestHooksForTests } from "../server/public-html";

const zalandoListingHtml = `<!doctype html><script>window.__hydrationDataConsume({"graphqlCache":{"card":{"data":{"product":{"id":"ern:product::TEST22Q001-O11","sku":"TEST22Q001-O11","name":"BOXY CARDIGAN - Gilet - brown","brand":{"name":"Test Brand"},"displayPrice":{"trackingCurrentAmount":79,"original":{"amount":9900,"currency":"CHF"}},"mediumModelImage":{"uri":"https://img.example.test/cardigan.jpg"},"uri":"https://fr.zalando.ch/test-boxy-cardigan-test22q001-o11.html","silhouette":"CARDIGAN"}}}}})</script>`;

const zalandoProductGroupHtml = `<!doctype html><script type="application/ld+json">[{"@context":"https://schema.org/","@type":"ProductGroup","brand":{"@type":"Brand","name":"Test Brand"},"name":"BOXY CARDIGAN - Gilet - brown","productGroupID":"TEST22Q001-O11","url":"https://fr.zalando.ch/test-boxy-cardigan-test22q001-o11.html","image":["https://img.example.test/cardigan.jpg"],"hasVariant":[{"@type":"Product","size":"MxR","offers":{"@type":"Offer","priceCurrency":"CHF","price":"79","availability":"https://schema.org/InStock"}},{"@type":"Product","size":"LxR","offers":{"@type":"Offer","priceCurrency":"CHF","price":"79","availability":"https://schema.org/OutOfStock"}}]}]</script>`;

function ids(): () => string {
  let index = 0;
  return () => `discovery_${++index}`;
}

function product(sourceId: string, overrides: Partial<RawProduct> = {}): RawProduct {
  return {
    sourceId,
    url: `https://www.zalando.ch/test-${sourceId}.html?tracking=listing`,
    brand: "Test",
    name: `Product ${sourceId}`,
    price: 80,
    currency: "CHF",
    images: [`https://images.example.test/${sourceId}.jpg`],
    ...overrides,
  };
}

test("About You listings expose exact M/L availability without inventing detail data", () => {
  const observedAt = "2026-08-29T10:00:00.000Z";
  assert.equal(aboutYouSourceIdFromUrl("https://www.aboutyou.ch/p/brand/boxy-jacket-32163979?tracking=1"), "32163979");
  assert.deepEqual(aboutYouSizesFromText("CHF 78.40 Available sizes: S, M, L, XL Add to basket Originally: CHF 112.00"), {
    known: true,
    sizes: ["S", "M", "L", "XL"],
  });
  const product = normalizeAboutYouListingCard({
    url: "https://www.aboutyou.ch/p/brand/boxy-jacket-32163979?tracking=1",
    brand: "Test Brand",
    name: "Boxy Jacket",
    image: "https://cdn.example.test/jacket.jpg",
    alt: "Test Brand Boxy Jacket in Brown: front",
    text: "CHF 78.40 Available sizes: S, M, L, XL Add to basket Originally: CHF 112.00",
  }, observedAt);
  assert.ok(product);
  assert.equal(product.price, 78.4);
  assert.equal(product.originalPrice, 112);
  assert.equal(product.stockStatus, "in_stock");
  assert.deepEqual(product.sizes, ["S", "M", "L", "XL"]);
  assert.equal(product.sizesCheckedAt, observedAt);
  assert.equal(product.attributes?.sizeAvailabilityKnown, true);
  assert.equal(product.url, "https://www.aboutyou.ch/p/brand/boxy-jacket-32163979");
  const [target] = buildAboutYouDiscoveryTargets({ source: "aboutyou-ch", category: "Vestes", sizes: ["M", "L"], maxItems: 30 });
  assert.equal(target?.url, "https://www.aboutyou.ch/c/men/clothing/jackets-20320");
  assert.equal(target?.appliedFilters.sizes, "post_fetch");
  assert.equal(discoveryAdapterFor("aboutyou-ch").id, "aboutyou-ch");
  assert.equal(adapterFor(new URL("https://fr.aboutyou.ch/p/brand/boxy-jacket-32163979")).id, "aboutyou-ch");
});

test("About You maps baggy lightweight pants to its public listing facets", () => {
  const [target] = buildAboutYouDiscoveryTargets({
    source: "aboutyou-ch",
    category: "Pantalons",
    query: "pantalon baggy léger homme",
    maxItems: 30,
  });
  const url = new URL(target!.url);
  assert.equal(url.pathname, "/c/men/clothing/pants-20330");
  assert.equal(url.searchParams.get("trousersCut"), "216289");
  assert.equal(url.searchParams.get("materialStyle"), "56687");
  assert.equal(target?.appliedFilters.query, "listing");
});

test("About You maps multilingual sock searches to the exact men's socks listing", () => {
  for (const query of ["chaussettes homme", "men socks", "Socken Herren", "calzini uomo", "calcetines hombre"]) {
    const [target] = buildAboutYouDiscoveryTargets({
      source: "aboutyou-ch",
      category: "Accessoires",
      query,
      maxItems: 30,
    });
    assert.equal(new URL(target!.url).pathname, "/c/maenner/bekleidung/waesche/socken-20294", query);
    assert.equal(target?.appliedFilters.query, "listing", query);
    assert.equal(target?.appliedFilters.category, "listing", query);
  }
});

test("About You product HTML imports exact in-stock variants and a shared gallery", async () => {
  const html = `<!doctype html><script type="application/ld+json">[{"@context":"https://schema.org/","@type":"ProductGroup","productGroupID":"MFX0566-130","name":"DAN FOX APPAREL Shirt 'Jonte'","category":"T-Shirts","brand":{"@type":"Brand","name":"DAN FOX APPAREL"},"hasVariant":[{"@type":"Product","color":"Taupe","size":"M","image":["https://cdn.example.com/front.jpg","https://cdn.example.com/back.jpg"],"offers":{"@type":"Offer","price":34.9,"priceCurrency":"CHF","availability":"https://schema.org/InStock"}},{"@type":"Product","color":"Taupe","size":"L","image":["https://cdn.example.com/front.jpg","https://cdn.example.com/back.jpg"],"offers":{"@type":"Offer","price":34.9,"priceCurrency":"CHF","availability":"https://schema.org/InStock"}},{"@type":"Product","color":"Taupe","size":"XL","image":["https://cdn.example.com/front.jpg"],"offers":{"@type":"Offer","price":34.9,"priceCurrency":"CHF","availability":"https://schema.org/OutOfStock"}}]}]</script>`;
  const product = await aboutYouAdapter.extractDetailHtml?.(
    html,
    "https://en.aboutyou.ch/p/dan-fox-apparel/shirt-jonte-16508944?tracking=1",
  );
  assert.ok(product);
  assert.equal(product.sourceId, "16508944");
  assert.equal(product.url, "https://www.aboutyou.ch/p/dan-fox-apparel/shirt-jonte-16508944");
  assert.equal(product.category, "T-Shirts");
  assert.equal(product.color, "Taupe");
  assert.equal(product.price, 34.9);
  assert.deepEqual(product.sizes, ["M", "L"]);
  assert.deepEqual(product.images, [
    "https://cdn.example.com/front.jpg",
    "https://cdn.example.com/back.jpg",
  ]);
  assert.equal(product.attributes?.sizeAvailabilityKnown, true);
});

test("About You post-filters exact requested sizes and preserves confirmed listing freshness", async () => {
  const observedAt = "2026-08-29T10:00:00.000Z";
  const service = new DiscoveryService({
    sameDomainDelayMs: 0,
    idFactory: ids(),
    fetcher: {
      async fetch() {
        const make = (id: string, sizes: string[], known = true): RawProduct => ({
          sourceId: id,
          url: `https://www.aboutyou.ch/p/brand/item-${id}`,
          brand: "Brand",
          name: `Item ${id}`,
          price: 80,
          sizes,
          rawSizes: sizes,
          stockStatus: known ? "in_stock" : "unknown",
          sizesCheckedAt: known ? observedAt : null,
          stockCheckedAt: known ? observedAt : null,
          attributes: { sizeAvailabilityKnown: known },
        });
        return [make("10000001", ["M"]), make("10000002", ["XL"]), make("10000003", [], false)];
      },
    },
  });
  const started = service.start({ intent: { source: "aboutyou-ch", category: "Vestes", sizes: ["M", "L"], sizeMode: "any", maxItems: 10 } });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.discovered, 1);
  assert.equal(finished.filtered, 2);
  assert.deepEqual(finished.results[0]?.sizes, ["M"]);
  assert.equal(finished.results[0]?.stockStatus, "in_stock");
  assert.equal(finished.results[0]?.sizesCheckedAt, observedAt);
  await service.close();
});

test("Zalando M OR L is a finite union of public size listings", () => {
  assert.equal(
    zalandoSourceIdFromUrl("https://fr.zalando.ch/redefined-rebel-gilet-mole-r0622q08v-o11.html?size=M"),
    "R0622Q08V-O11",
  );
  const targets = buildZalandoDiscoveryTargets({
    source: "zalando-ch",
    query: "cardigan court brun",
    category: "knitwear",
    sizes: ["M", "L", "M"],
    sizeMode: "any",
    maxItems: 40,
  });

  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((target) => target.matchedSizeIntent), ["M", "L"]);
  assert.match(targets[0]!.url, /pulls-gilets-homme\/__taille-M\//);
  assert.match(targets[1]!.url, /pulls-gilets-homme\/__taille-L\//);
  assert.equal(new URL(targets[0]!.url).searchParams.get("q"), "cardigan court brun");
  assert.ok(targets.every((target) => target.appliedFilters.sizes === "listing"));

  const impossibleIntersection = buildZalandoDiscoveryTargets({
    source: "zalando-ch",
    sizes: ["M", "L"],
    sizeMode: "all",
    maxItems: 10,
  });
  assert.equal(impossibleIntersection.length, 1);
  assert.equal(impossibleIntersection[0]!.appliedFilters.sizes, "intent_only");
});

test("Zalando server HTML exposes listing cards and exact ProductGroup stock", () => {
  const listing = extractZalandoListingHtml(
    zalandoListingHtml,
    "https://fr.zalando.ch/pulls-gilets-homme/__taille-M/",
  );
  assert.equal(listing.length, 1);
  assert.equal(listing[0]!.sourceId, "TEST22Q001-O11");
  assert.equal(listing[0]!.price, 79);
  assert.equal(listing[0]!.originalPrice, 99);
  assert.equal(listing[0]!.stockStatus, "unknown");

  const detail = extractZalandoDetailHtml(
    zalandoProductGroupHtml,
    "https://fr.zalando.ch/test-boxy-cardigan-test22q001-o11.html",
    "2026-08-29T12:00:00.000Z",
  );
  assert.ok(detail);
  assert.equal(detail.stockStatus, "in_stock");
  assert.deepEqual(detail.rawSizes, ["MxR"]);
  assert.deepEqual(detail.sizes, ["M"]);
  assert.equal(detail.attributes?.sizeAvailabilityKnown, true);
  assert.equal(detail.sizesCheckedAt, "2026-08-29T12:00:00.000Z");
});

test("HTTP-first discovery uses structured HTML without launching a browser", async (t) => {
  setPublicNetworkTestHooksForTests({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async () => new Response(zalandoListingHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  const fetcher = new PlaywrightDiscoveryFetcher({ maxScrolls: 0 });
  t.after(async () => {
    setPublicNetworkTestHooksForTests(null);
    await fetcher.close();
  });
  const products = await fetcher.fetch({
    source: "zalando-ch",
    intent: { source: "zalando-ch", maxItems: 3, sizes: ["M", "L"], sizeMode: "any" },
    target: {
      url: "https://fr.zalando.ch/pulls-gilets-homme/__taille-M/",
      matchedSizeIntent: "M",
      appliedFilters: { query: "unsupported", category: "listing", sizes: "listing", price: "unsupported" },
    },
    limit: 3,
  }, { signal: new AbortController().signal });
  assert.deepEqual(products.map((product) => product.sourceId), ["TEST22Q001-O11"]);
});

test("generic JSON-LD import understands public product variants", () => {
  const product = extractGenericJsonLdProduct(
    zalandoProductGroupHtml.replaceAll("fr.zalando.ch", "www.arket.com"),
    "https://www.arket.com/en-ch/product/test-cardigan",
    "2026-08-29T12:00:00.000Z",
  );
  assert.ok(product);
  assert.equal(product.stockStatus, "in_stock");
  assert.deepEqual(product.sizes, ["MXR"]);
  assert.equal(product.price, 79);
});

test("AliExpress helpers keep canonical public item identity and only parse visible CHF", () => {
  const tracked = "https://www.aliexpress.com/item/1005007654321000.html?spm=tracking#details";
  assert.equal(aliExpressSourceId(tracked), "1005007654321000");
  assert.equal(
    canonicalAliExpressProductUrl(tracked),
    "https://www.aliexpress.com/item/1005007654321000.html",
  );
  assert.equal(
    canonicalAliExpressProductUrl("//de.aliexpress.com/item/1005007654321000.html?spm=listing"),
    "https://www.aliexpress.com/item/1005007654321000.html",
  );
  assert.equal(parseAliExpressChfPrice("Offer CHF 12.40 - CHF 19.00"), 12.4);
  assert.equal(parseAliExpressChfPrice("Prix Fr. 1’234,50"), 1234.5);
  assert.equal(parseAliExpressChfPrice("US $12.40"), null);
  assert.equal(parseAliExpressChfPrice("CHF 32 21 vendus"), 32);
  assert.match(classifyAliExpressAccessBlock({
    pageUrl: "https://www.aliexpress.com/p/captcha/verify",
    title: "Security verification",
  }) ?? "", /no bypass/i);
  assert.match(classifyAliExpressAccessBlock({
    pageUrl: "https://www.aliexpress.com/item/1005007654321000.html",
    title: "Just a moment...",
    bodyText: "Cloudflare Ray ID",
  }) ?? "", /anti-bot|CAPTCHA/i);
  assert.equal(classifyAliExpressAccessBlock({
    pageUrl: "https://www.aliexpress.com/item/1005007654321000.html",
    title: "Vintage necklace",
  }), null);

  const [target] = buildAliExpressDiscoveryTargets({
    source: "aliexpress",
    query: "vintage necklace men",
    category: "accessories",
    sizes: ["M", "L"],
    sizeMode: "any",
    minPrice: 5,
    maxPrice: 30,
    maxItems: 20,
  });
  assert.equal(new URL(target!.url).searchParams.get("SearchText"), "vintage necklace men accessories");
  assert.equal(target!.appliedFilters.sizes, "intent_only");
  assert.equal(target!.appliedFilters.price, "post_fetch");
  assert.equal(adapterFor(new URL(tracked)).id, "aliexpress");
  assert.equal(discoveryAdapterFor("aliexpress").id, "aliexpress");
});

test("AliExpress listing and detail normalization never invent CHF, stock, or sizes", () => {
  const listing = normalizeAliExpressListingCard({
    url: "https://www.aliexpress.com/item/1005007000000001.html?spm=listing",
    name: "Minimal chain necklace",
    image: "https://ae.example.test/necklace.jpg",
    text: "Minimal chain necklace US $8.00",
  });
  assert.ok(listing);
  assert.equal(listing.price, null);
  assert.equal(listing.stockStatus, "unknown");
  assert.deepEqual(listing.sizes, []);
  assert.equal(listing.attributes?.sizeAvailabilityKnown, false);

  const observedAt = "2026-08-29T09:30:00.000Z";
  const unknown = normalizeAliExpressDetail({
    url: "https://www.aliexpress.com/item/1005007000000001.html",
    name: "Minimal chain necklace",
    images: ["https://ae.example.test/necklace.jpg"],
    offerPrice: "8.00",
    offerCurrency: "USD",
    bodyText: "US $8.00",
    stockStatus: "unknown",
    sizeCandidates: [],
  }, observedAt);
  assert.ok(unknown);
  assert.equal(unknown.price, null);
  assert.equal(unknown.priceCheckedAt, undefined);
  assert.equal(unknown.stockCheckedAt, undefined);
  assert.equal(unknown.sizesCheckedAt, undefined);

  const reliable = normalizeAliExpressDetail({
    url: "https://www.aliexpress.com/item/1005007000000002.html?aff=tracking",
    name: "Washed overshirt",
    images: [],
    offerPrice: "22.50",
    offerCurrency: "CHF",
    bodyText: "CHF 22.50",
    stockStatus: "in_stock",
    sizeCandidates: ["M", "L"],
  }, observedAt);
  assert.ok(reliable);
  assert.equal(reliable.price, 22.5);
  assert.equal(reliable.priceCheckedAt, observedAt);
  assert.equal(reliable.stockCheckedAt, observedAt);
  assert.equal(reliable.sizesCheckedAt, observedAt);
  assert.deepEqual(reliable.sizes, ["M", "L"]);
  assert.equal(reliable.attributes?.sizeAvailabilityKnown, true);
});

test("discovery is serial, price-filtered and deduplicates the M/L union without confirming sizes", async () => {
  let active = 0;
  let maxActive = 0;
  const known = new Set(["known"]);
  const persisted: RawProduct[] = [];
  const fetcher: DiscoveryFetcher = {
    async fetch(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (request.target.matchedSizeIntent === "M") {
        return [
          product("shared"),
          product("too-expensive", { price: 500 }),
          product("known"),
          product("bad", { url: "https://malicious.example.test/item.html" }),
        ];
      }
      return [
        product("shared", { images: ["https://images.example.test/shared-l.jpg"] }),
        product("only-l", { price: 120 }),
      ];
    },
  };
  const service = new DiscoveryService({
    fetcher,
    sameDomainDelayMs: 0,
    idFactory: ids(),
    isKnownProduct: (candidate) => Boolean(candidate.sourceId && known.has(candidate.sourceId)),
    onProducts(products) {
      persisted.push(...products);
    },
  });
  const started = service.start({
    intent: {
      source: "zalando-ch",
      query: "brun",
      category: "jackets",
      sizes: ["M", "L"],
      sizeMode: "any",
      minPrice: 20,
      maxPrice: 150,
      maxItems: 10,
    },
  });
  const finished = await service.waitFor(started.id);

  assert.equal(finished.status, "succeeded");
  assert.equal(finished.progress, 1);
  assert.equal(maxActive, 1);
  assert.equal(finished.discovered, 2);
  assert.equal(finished.duplicates, 2);
  assert.equal(finished.filtered, 1);
  assert.equal(finished.invalid, 1);
  assert.equal(persisted.length, 2);
  const shared = finished.results.find((candidate) => candidate.sourceId === "shared");
  assert.ok(shared);
  assert.deepEqual(shared.sizes, []);
  assert.deepEqual(shared.rawSizes, []);
  assert.equal(shared.stockStatus, "unknown");
  assert.equal(shared.stockCheckedAt, null);
  assert.equal(shared.sizesCheckedAt, null);
  assert.equal(shared.attributes?.sizeAvailabilityKnown, false);
  assert.deepEqual(shared.attributes?.requestedSizes, ["M", "L"]);
  assert.deepEqual(shared.attributes?.listingMatchedSizeIntents, ["M", "L"]);
  assert.equal(shared.url, "https://www.zalando.ch/test-shared.html");
  await service.close();
});

test("a block is never auto-retried but can be retried explicitly", async () => {
  let calls = 0;
  const service = new DiscoveryService({
    fetcher: {
      async fetch() {
        calls += 1;
        if (calls === 1) throw new DiscoveryBlockedError("CAPTCHA detected; no bypass was attempted.");
        return [{
          sourceId: "1005007654321000",
          url: "https://www.aliexpress.com/item/1005007654321000.html?spm=retry",
          name: "Vintage necklace",
          price: 14,
          currency: "CHF",
        }];
      },
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = service.start({
    intent: { source: "aliexpress", query: "necklace men", maxItems: 5 },
  });
  const blocked = await service.waitFor(started.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.items[0]!.attempts, 1);
  assert.equal(calls, 1);

  service.retry(started.id);
  const retried = await service.waitFor(started.id);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.items[0]!.attempts, 2);
  assert.equal(retried.results[0]!.url, "https://www.aliexpress.com/item/1005007654321000.html");
  await service.close();
});

test("HTTP 429 pauses and resumes the same listing automatically", async () => {
  let calls = 0;
  let clock = Date.parse("2026-08-31T10:00:00.000Z");
  const sleeps: number[] = [];
  const service = new DiscoveryService({
    fetcher: {
      async fetch() {
        calls += 1;
        if (calls === 1) {
          throw new DiscoveryBlockedError(
            "Shop access stopped with HTTP 429; no bypass was attempted.",
            12_000,
          );
        }
        return [product("after-rate-limit")];
      },
    },
    sameDomainDelayMs: 0,
    rateLimitCooldownMs: 30_000,
    maxRateLimitRetries: 1,
    now: () => new Date(clock),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    idFactory: ids(),
  });
  const started = service.start({
    intent: { source: "zalando-ch", query: "brown knit", maxItems: 5 },
  });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [12_000]);
  assert.equal(finished.cooldownUntil, undefined);
  await service.close();
});

test("transient listing errors retry at most twice after the first attempt", async () => {
  let calls = 0;
  const service = new DiscoveryService({
    fetcher: {
      async fetch() {
        calls += 1;
        throw new Error("temporary network failure");
      },
    },
    sameDomainDelayMs: 0,
    maxRetries: 99,
    idFactory: ids(),
  });
  const started = service.start({
    intent: { source: "zalando-ch", query: "overshirt", maxItems: 5 },
  });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.items[0]!.attempts, 3);
  assert.equal(calls, 3);
  await service.close();
});

test("a failed catalog sink rolls back accepted keys before the automatic retry", async () => {
  let fetches = 0;
  let writes = 0;
  const service = new DiscoveryService({
    fetcher: {
      async fetch() {
        fetches += 1;
        return [product("sink-retry")];
      },
    },
    onProducts() {
      writes += 1;
      if (writes === 1) throw new Error("catalog temporarily locked");
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = service.start({
    intent: { source: "zalando-ch", query: "brown knit", maxItems: 5 },
  });
  const finished = await service.waitFor(started.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.discovered, 1);
  assert.equal(finished.results[0]?.sourceId, "sink-retry");
  assert.equal(fetches, 2);
  assert.equal(writes, 2);
  await service.close();
});

test("cancel aborts the active public listing and cancels queued size branches", async () => {
  let notifyStarted!: () => void;
  const fetching = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const service = new DiscoveryService({
    fetcher: {
      async fetch(_request, context) {
        notifyStarted();
        return new Promise<RawProduct[]>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new DiscoveryCancelledError("cancelled")), { once: true });
        });
      },
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = service.start({
    intent: {
      source: "zalando-ch",
      query: "wide trousers",
      sizes: ["M", "L"],
      sizeMode: "any",
      maxItems: 20,
    },
  });
  await fetching;
  service.cancel(started.id);
  const cancelled = await service.waitFor(started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.items.map((item) => item.status), ["cancelled", "cancelled"]);
  await service.close();
});

class MemoryDiscoveryStore implements DiscoveryJobStore {
  readonly jobs = new Map<string, DiscoveryJobSnapshot>();

  saveDiscoveryJob(snapshot: DiscoveryJobSnapshot): void {
    this.jobs.set(snapshot.id, structuredClone(snapshot));
  }

  getDiscoveryJob(id: string): DiscoveryJobSnapshot | null {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  listDiscoveryJobs(limit: number): DiscoveryJobSnapshot[] {
    return [...this.jobs.values()].slice(0, limit).map((job) => structuredClone(job));
  }
}

test("persisted interrupted jobs are inert until an explicit resume", async () => {
  const intent: DiscoveryIntent = {
    source: "zalando-ch",
    query: "cropped jacket",
    maxItems: 5,
  };
  const [target] = buildZalandoDiscoveryTargets(intent);
  const time = "2026-08-29T08:00:00.000Z";
  const store = new MemoryDiscoveryStore();
  store.jobs.set("persisted", {
    id: "persisted",
    source: "zalando-ch",
    intent,
    status: "running",
    total: 1,
    completed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    progress: 0,
    discovered: 0,
    duplicates: 0,
    filtered: 0,
    invalid: 0,
    results: [],
    items: [{
      ...target!,
      id: "listing",
      status: "running",
      attempts: 1,
      found: 0,
      accepted: 0,
      duplicates: 0,
      filtered: 0,
      invalid: 0,
      startedAt: time,
    }],
    createdAt: time,
    startedAt: time,
    updatedAt: time,
  });
  let calls = 0;
  const service = new DiscoveryService({
    store,
    fetcher: {
      async fetch() {
        calls += 1;
        return [product("resumed")];
      },
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  assert.equal(service.get("persisted")?.status, "running");
  await Promise.resolve();
  assert.equal(calls, 0);

  service.resume("persisted");
  const finished = await service.waitFor("persisted");
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.discovered, 1);
  assert.equal(finished.items[0]!.attempts, 2);
  assert.equal(calls, 1);
  assert.equal(store.getDiscoveryJob("persisted")?.status, "succeeded");
  await service.close();
});

test("file job store writes atomic JSON snapshots and reloads without auto-running", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "wardrobe-discovery-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new FileDiscoveryJobStore(root);
  assert.equal(store.getDiscoveryJob("../outside"), null);
  let calls = 0;
  const firstService = new DiscoveryService({
    store,
    fetcher: {
      async fetch() {
        calls += 1;
        return [product("stored")];
      },
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  const started = firstService.start({
    intent: { source: "zalando-ch", query: "brown jacket", maxItems: 3 },
  });
  const finished = await firstService.waitFor(started.id);
  assert.equal(finished.status, "succeeded");
  await firstService.close();
  assert.deepEqual(readdirSync(root), [`${started.id}.json`]);
  assert.equal(store.getDiscoveryJob(started.id)?.results[0]?.sourceId, "stored");

  const secondService = new DiscoveryService({
    store,
    fetcher: {
      async fetch() {
        calls += 1;
        return [];
      },
    },
  });
  assert.equal(secondService.get(started.id)?.status, "succeeded");
  assert.equal(secondService.list()[0]?.id, started.id);
  await Promise.resolve();
  assert.equal(calls, 1);
  await secondService.close();
});

test("batch start stays finite and validates every intent before launching", async () => {
  let calls = 0;
  const service = new DiscoveryService({
    fetcher: {
      async fetch() {
        calls += 1;
        return [];
      },
    },
    sameDomainDelayMs: 0,
    idFactory: ids(),
  });
  assert.throws(() => service.startBatch({
    intents: [
      { source: "zalando-ch", query: "jacket", maxItems: 5 },
      { source: "aliexpress", query: "necklace", maxItems: 0 },
    ],
  }), /maxItems/);
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(service.list().length, 0);
  assert.throws(() => service.startBatch({
    intents: [
      { source: "zalando-ch", query: "jacket", maxItems: 5 },
      {
        source: "aliexpress",
        query: "necklace",
        listingUrl: "https://malicious.example.test/search",
        maxItems: 5,
      },
    ],
  }), /does not allow host/);
  assert.equal(service.list().length, 0);

  const jobs = service.startBatch({
    intents: [
      { source: "zalando-ch", query: "jacket", maxItems: 5 },
      { source: "aliexpress", query: "necklace", maxItems: 5 },
    ],
  });
  assert.equal(jobs.length, 2);
  await Promise.all(jobs.map((job) => service.waitFor(job.id)));
  assert.equal(calls, 2);
  await service.close();
});
