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

export type ShopAdapter = {
  id: string;
  label: string;
  allowedHosts: string[];
  matches(url: URL): boolean;
  extractListing(page: Page): Promise<RawProduct[]>;
  extractDetail(page: Page): Promise<RawProduct | null>;
};
