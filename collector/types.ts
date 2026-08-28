import type { Page } from "playwright";
import type { Product } from "../src/domain/catalog";

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
  sizes?: string[];
  images?: string[];
  available?: boolean;
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
