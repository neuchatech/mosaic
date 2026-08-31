import { Command } from "commander";
import { PlaywrightCrawler } from "crawlee";
import { CatalogRepository } from "../server/repository";
import {
  AcquisitionService,
  mergeCollectedDetail,
  PlaywrightDetailFetcher,
} from "../server/acquisition";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { normalizeProduct } from "./normalize";
import { adapterFor, listAdapters } from "./registry";
import type { RawProduct } from "./types";

const program = new Command();

program
  .name("wardrobe-collector")
  .description("User-triggered, rate-limited catalog collector. Never logs in, bypasses CAPTCHAs, or checks out.")
  .option("--list-adapters", "List installed shop adapters")
  .option("--url <url>", "Explicit listing or product URL to collect")
  .option("--generic", "Use the conservative JSON-LD adapter for an unregistered host", false)
  .option("--headed", "Show the browser while collecting", false)
  .option("--details <count>", "Visit up to N product pages for richer attributes", "0")
  .option("--enrich-existing <count>", "Refresh detail data for up to N existing catalog products", "0")
  .option("--scrolls <count>", "Number of gentle listing-page scrolls", "8")
  .option("--max-products <count>", "Hard cap for imported products", "500")
  .parse();

const options = program.opts<{
  listAdapters?: boolean;
  url?: string;
  generic: boolean;
  headed: boolean;
  details: string;
  enrichExisting: string;
  scrolls: string;
  maxProducts: string;
}>();

if (options.listAdapters) {
  console.table(listAdapters());
  process.exit(0);
}
const enrichExisting = Math.min(Math.max(Number(options.enrichExisting), 0), 5000);
if (!options.url && enrichExisting === 0) {
  throw new Error("--url or --enrich-existing is required unless --list-adapters is used");
}

const startUrl = options.url ? new URL(options.url) : null;
const listingAdapter = startUrl ? adapterFor(startUrl, options.generic) : null;
if (startUrl && listingAdapter && !listingAdapter.allowedHosts.includes(startUrl.hostname)) {
  throw new Error(`Host ${startUrl.hostname} is not allowed by adapter ${listingAdapter.id}.`);
}

const maxProducts = Math.min(Math.max(Number(options.maxProducts), 1), 5000);
const detailLimit = Math.min(Math.max(Number(options.details), 0), maxProducts);
const scrolls = Math.min(Math.max(Number(options.scrolls), 0), 30);
const collected = new Map<string, RawProduct>();
const repository = new CatalogRepository();
const existingProducts = repository.listProducts({ limit: 10_000 });
const existingByUrl = new Map(existingProducts.map((product) => [product.url, product]));

console.log(`Collecting product data at a conservative rate. Checkout and account actions are out of scope.`);

const crawler = new PlaywrightCrawler({
  headless: !options.headed,
  maxConcurrency: 1,
  // Human-paced by default. Sessions preserve the same cookie jar instead of
  // presenting each product page as a brand-new visitor.
  sameDomainDelaySecs: 5,
  maxRequestsPerMinute: 10,
  useSessionPool: true,
  persistCookiesPerSession: true,
  maxSessionRotations: 0,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 90,
  launchContext: { launchOptions: { channel: "chrome" } },
  async requestHandler({ page, request, addRequests, log }) {
    const requestUrl = new URL(request.url);
    const requestAdapter = adapterFor(requestUrl, options.generic);
    if (!requestAdapter.allowedHosts.includes(requestUrl.hostname)) return;

    if (request.userData.kind === "detail") {
      const detail = await requestAdapter.extractDetail(page);
      if (detail) {
        const current = collected.get(detail.url) ?? {} as RawProduct;
        collected.set(detail.url, { ...current, ...detail });
      }
      return;
    }

    // Zalando hydrates its product grid after the initial navigation event.
    // Waiting for the first real product link avoids treating a healthy page
    // as an empty listing on fast local runs.
    await page.locator('article a[href*=".html"]').first()
      .waitFor({ state: "attached", timeout: 15_000 })
      .catch(() => undefined);
    for (let index = 0; index < scrolls; index += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(750);
    const listingProducts = (await requestAdapter.extractListing(page)).slice(0, maxProducts);
    for (const product of listingProducts) collected.set(product.url, product);
    log.info(`Found ${collected.size} unique product cards.`);

    if (detailLimit > 0) {
      await addRequests(
        listingProducts.slice(0, detailLimit).map((product) => ({
          url: product.url,
          uniqueKey: `detail:${product.url}`,
          userData: { kind: "detail" },
        })),
      );
    }
  },
});

if (startUrl) {
  const kind = /\.html$/i.test(startUrl.pathname) ? "detail" : "listing";
  await crawler.run([{ url: startUrl.href, userData: { kind } }]);
}
const imported = [...collected.values()].slice(0, maxProducts).map((raw) => {
  const existing = existingByUrl.get(raw.url);
  if (!existing) {
    const source = adapterFor(new URL(raw.url), options.generic).id;
    return normalizeProduct(source, raw);
  }
  return mergeCollectedDetail(existing, raw, new Date().toISOString());
});
repository.upsertProducts(imported);

let enriched = 0;
if (enrichExisting > 0) {
  const targets = existingProducts
    .filter((product) => product.kind === "shop" && product.url && !product.sizesCheckedAt)
    .filter((product) => {
      try {
        adapterFor(new URL(product.url), false);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, enrichExisting)
    .map((product) => ({ productId: product.id, url: product.url }));
  if (targets.length > 0) {
    const acquisition = new AcquisitionService(repository, {
      fetcher: new PlaywrightDetailFetcher({ headed: options.headed }),
    });
    let lastCompleted = -1;
    acquisition.subscribe((job) => {
      if (job.completed === lastCompleted) return;
      lastCompleted = job.completed;
      console.log(`Detail enrichment: ${job.completed}/${job.total} (${job.status}).`);
    });
    const job = acquisition.start({ targets, source: "collector-cli" });
    const finished = await acquisition.waitFor(job.id);
    enriched = finished.succeeded;
    if (finished.blocked > 0) {
      console.warn(`${finished.blocked} page(s) required login or CAPTCHA verification and were left blocked.`);
    }
    if (finished.failed > 0) console.warn(`${finished.failed} detail page(s) failed after retries.`);
    await acquisition.close();
  }
}
const allProducts = repository.listProducts({ limit: 10_000 });
repository.replaceCoordinates(compactProjection(projectProducts(allProducts)));
console.log(`Imported ${imported.length} and enriched ${enriched} products in Wardrobe Atlas.`);
