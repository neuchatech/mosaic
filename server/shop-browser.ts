import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

type PageOperation<T> = (page: Page, context: BrowserContext) => Promise<T>;

const preferredUntilByHost = new Map<string, number>();

function preferenceKey(url: string): string {
  return new URL(url).hostname.replace(/^(?:www|fr|en|de|it)\./i, "");
}

/**
 * Remember that the stateless HTTP reader was refused by a shop. Subsequent
 * attempts use the same real-Chrome profile directly instead of repeating the
 * request that just failed. This is routing, not identity rotation or bypass.
 */
export function preferBrowserForShop(url: string, durationMs = 6 * 60 * 60_000): void {
  preferredUntilByHost.set(preferenceKey(url), Date.now() + Math.max(0, durationMs));
}

export function shopPrefersBrowser(url: string): boolean {
  const host = preferenceKey(url);
  const deadline = preferredUntilByHost.get(host) ?? 0;
  if (deadline <= Date.now()) {
    preferredUntilByHost.delete(host);
    return false;
  }
  return true;
}

/** Test seam; no production caller should clear an active shop preference. */
export function resetShopBrowserPreferencesForTests(): void {
  preferredUntilByHost.clear();
}

class PersistentShopBrowser {
  private contextPromise: Promise<BrowserContext> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly headed: boolean) {}

  async withPage<T>(signal: AbortSignal, operation: PageOperation<T>): Promise<T> {
    const queued = this.queue.catch(() => undefined).then(async () => {
      if (signal.aborted) throw signal.reason ?? new Error("Browser operation aborted.");
      const context = await this.getContext();
      const page = await context.newPage();
      const closePage = () => { void page.close().catch(() => undefined); };
      signal.addEventListener("abort", closePage, { once: true });
      try {
        return await operation(page, context);
      } finally {
        signal.removeEventListener("abort", closePage);
        await page.close().catch(() => undefined);
      }
    });
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async close(): Promise<void> {
    const context = await this.contextPromise?.catch(() => null);
    await context?.close().catch(() => undefined);
    this.contextPromise = null;
  }

  private getContext(): Promise<BrowserContext> {
    if (this.contextPromise) return this.contextPromise;
    const profile = resolve(process.cwd(), "data/browser-sessions", this.headed ? "interactive" : "background");
    mkdirSync(profile, { recursive: true });
    this.contextPromise = chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: !this.headed,
      locale: "fr-CH",
      timezoneId: "Europe/Zurich",
      viewport: { width: 1440, height: 1000 },
    }).then(async (context) => {
      // Persistent contexts may open with an unused about:blank tab. Keep the
      // session single-page so access checks always inspect the active shop.
      await Promise.all(context.pages().map((page) => page.close().catch(() => undefined)));
      return context;
    }).catch((error) => {
      this.contextPromise = null;
      throw error;
    });
    return this.contextPromise;
  }
}

const sessions = new Map<string, PersistentShopBrowser>();

export function sharedShopBrowser(headed = false): PersistentShopBrowser {
  const key = headed ? "interactive" : "background";
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new PersistentShopBrowser(headed);
  sessions.set(key, session);
  return session;
}
