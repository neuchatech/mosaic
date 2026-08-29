import { aliExpressAdapter } from "./adapters/aliexpress";
import { aboutYouAdapter } from "./adapters/aboutyou";
import { genericJsonLdAdapter } from "./adapters/generic-jsonld";
import { zalandoAdapter } from "./adapters/zalando";
import type { DiscoverySource, ShopAdapter } from "./types";

const adapters: ShopAdapter[] = [zalandoAdapter, aboutYouAdapter, aliExpressAdapter];

export function adapterFor(url: URL, allowGeneric = false): ShopAdapter {
  const adapter = adapters.find((candidate) => candidate.matches(url));
  if (adapter) return adapter;
  if (allowGeneric) return genericJsonLdAdapter(url.hostname);
  throw new Error(
    `No adapter registered for ${url.hostname}. Add one under collector/adapters, or pass --generic for a conservative JSON-LD import.`,
  );
}

export function discoveryAdapterFor(source: DiscoverySource): ShopAdapter {
  const adapter = adapters.find((candidate) => candidate.id === source);
  if (!adapter?.discovery) throw new Error(`No discovery adapter registered for ${source}.`);
  return adapter;
}

export function listAdapters(): Pick<ShopAdapter, "id" | "label" | "allowedHosts">[] {
  return adapters.map(({ id, label, allowedHosts }) => ({ id, label, allowedHosts }));
}
