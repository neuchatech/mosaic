import { Command } from "commander";
import { PlaywrightCrawler } from "crawlee";
import { CatalogRepository } from "../server/repository";
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
  .option("--scrolls <count>", "Number of gentle listing-page scrolls", "8")
  .option("--max-products <count>", "Hard cap for imported products", "500")
  .parse();

const options = program.opts<{
  listAdapters?: boolean;
  url?: string;
  generic: boolean;
  headed: boolean;
  details: string;
  scrolls: string;
  maxProducts: string;
}>();

if (options.listAdapters) {
  console.table(listAdapters());
  process.exit(0);
}
if (!options.url) throw new Error("--url is required unless --list-adapters is used");

const startUrl = new URL(options.url);
const adapter = adapterFor(startUrl, options.generic);
if (!adapter.allowedHosts.includes(startUrl.hostname)) {
  throw new Error(`Host ${startUrl.hostname} is not allowed by adapter ${adapter.id}.`);
}

const maxProducts = Math.min(Math.max(Number(options.maxProducts), 1), 5000);
const detailLimit = Math.min(Math.max(Number(options.details), 0), maxProducts);
const scrolls = Math.min(Math.max(Number(options.scrolls), 0), 30);
const collected = new Map<string, RawProduct>();

console.log(`Collecting ${adapter.label} at a conservative rate. Checkout and account actions are out of scope.`);

const crawler = new PlaywrightCrawler({
  headless: !options.headed,
  maxConcurrency: 1,
  sameDomainDelaySecs: 1.5,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 90,
  launchContext: { launchOptions: { channel: "chrome" } },
  async requestHandler({ page, request, addRequests, log }) {
    const requestUrl = new URL(request.url);
    if (!adapter.allowedHosts.includes(requestUrl.hostname)) return;

    if (request.userData.kind === "detail") {
      const detail = await adapter.extractDetail(page);
      if (detail) {
        const current = collected.get(detail.url) ?? {} as RawProduct;
        collected.set(detail.url, { ...current, ...detail });
      }
      return;
    }

    for (let index = 0; index < scrolls; index += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(450);
    }
    const listingProducts = (await adapter.extractListing(page)).slice(0, maxProducts);
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

await crawler.run([startUrl.href]);
const repository = new CatalogRepository();
const imported = [...collected.values()].slice(0, maxProducts).map((raw) => normalizeProduct(adapter.id, raw));
repository.upsertProducts(imported);
const allProducts = repository.listProducts({ limit: 10_000 });
repository.replaceCoordinates(compactProjection(projectProducts(allProducts)));
console.log(`Imported ${imported.length} products into Wardrobe Atlas.`);
