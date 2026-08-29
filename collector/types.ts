import type { Page } from "playwright";
import type { Product } from "../src/domain/catalog";

export type CollectedStockStatus = "in_stock" | "out_of_stock" | "unknown";

export type RawProduct = {
  sourceId?: string;
  url: string;
  brand?: string;
  name: string;
  description?: string;
  price?: number | null;
  originalPrice?: number | null;
  currency?: string;
  category?: string;
  color?: string;
  colorFamily?: string;
  fit?: string;
  materials?: string[];
  tags?: string[];
  /** Labels exactly as exposed by the shop before canonical normalization. */
  rawSizes?: string[];
  sizes?: string[];
  images?: string[];
  available?: boolean;
  stockStatus?: CollectedStockStatus;
  stockCheckedAt?: string | null;
  priceCheckedAt?: string | null;
  sizesCheckedAt?: string | null;
  attributes?: Product["attributes"];
};

export type DiscoverySource = "zalando-ch" | "aliexpress";
export type DiscoverySizeMode = "any" | "all";

/**
 * A bounded, user-supervised discovery request. `sizes` is an intent applied
 * to a shop listing when the adapter knows a stable public URL filter; it is
 * never proof that a particular product variant is currently available.
 */
export type DiscoveryIntent = {
  source: DiscoverySource;
  query?: string;
  category?: string;
  sizes?: string[];
  sizeMode?: DiscoverySizeMode;
  minPrice?: number;
  maxPrice?: number;
  /** Required hard cap across every listing target in this discovery job. */
  maxItems: number;
  /** Optional exact public listing URL. The adapter still validates its host. */
  listingUrl?: string;
};

export type DiscoveryFilterApplication = "listing" | "post_fetch" | "intent_only" | "unsupported";

export type DiscoveryListingTarget = {
  url: string;
  appliedFilters: {
    query: DiscoveryFilterApplication;
    category: DiscoveryFilterApplication;
    sizes: DiscoveryFilterApplication;
    price: DiscoveryFilterApplication;
  };
  /** One branch of an OR-size listing union, e.g. M then L. */
  matchedSizeIntent?: string;
};

export type ShopDiscoveryAdapter = {
  buildListingTargets(intent: DiscoveryIntent): DiscoveryListingTarget[];
  canonicalProductUrl?(url: URL): string;
  classifyAccessBlock?(input: {
    pageUrl: string;
    status?: number;
    title?: string;
    bodyText?: string;
    hasBlockingElement?: boolean;
  }): string | null;
};

export type ShopAdapter = {
  id: string;
  label: string;
  allowedHosts: string[];
  matches(url: URL): boolean;
  extractListing(page: Page): Promise<RawProduct[]>;
  extractDetail(page: Page): Promise<RawProduct | null>;
  discovery?: ShopDiscoveryAdapter;
};
