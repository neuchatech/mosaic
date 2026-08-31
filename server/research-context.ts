import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listAdapters } from "../collector/registry";
import type { Product } from "../src/domain/catalog";
import {
  researchRequestSchema,
  researchWorkspaceManifestSchema,
  type ResearchRequestInput,
  type ResearchSourceCapability,
  type ResearchWorkspaceManifest,
} from "../src/domain/research";
import type { CatalogRepository } from "./repository";

export type ResearchContextRepository = Pick<CatalogRepository,
  | "getWorkspace"
  | "listProducts"
  | "getCollection"
  | "listFieldDefinitions"
  | "inferWorkspaceSchema"
  | "getWorkspaceFacets"
>;

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function manifestItem(product: Product) {
  return {
    id: product.id,
    kind: product.kind,
    source: product.source,
    name: product.name,
    category: product.category,
    price: product.price,
    currency: product.currency,
    decision: product.decision,
    imageCount: product.images.length,
    attributes: product.attributes,
  };
}

export function installedResearchSources(): ResearchSourceCapability[] {
  const adapters: ResearchSourceCapability[] = listAdapters().map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    availability: "available",
    availabilityReason: "Installed in this MosAIc runtime.",
    hosts: [...adapter.allowedHosts],
    operations: ["discover", "import-url", "enrich", "structured-data", "persistent-browser"],
    notes: "Installed deterministic adapter with bounded public discovery and detail enrichment.",
  }));
  return [
    ...adapters,
    {
      id: "public-url",
      label: "Generic public product URL",
      availability: "available",
      availabilityReason: "The guarded public structured-data importer is installed.",
      hosts: [],
      operations: ["import-url", "structured-data"],
      notes: "Any supplied public HTTPS page with usable structured product data can be imported conservatively.",
    },
    {
      id: "interactive-browser",
      label: "ChatGPT desktop browser handoff",
      availability: "unavailable",
      availabilityReason: "A background Codex CLI process cannot control the ChatGPT desktop browser or inherit its Chrome connection. A user can perform the browser step in a separate desktop task and pass observations back to MosAIc.",
      hosts: [],
      operations: ["interactive-browser", "browser-observation-import"],
      notes: "This is an explicit supervised handoff, not an operation the background research agent can invoke directly.",
    },
  ];
}

export function buildResearchManifest(
  requestInput: ResearchRequestInput,
  repository: ResearchContextRepository,
): ResearchWorkspaceManifest {
  const request = researchRequestSchema.parse(requestInput);
  const workspace = repository.getWorkspace(request.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${request.workspaceId}`);

  const products = repository.listProducts({ workspaceId: workspace.id, limit: 10_000 });
  const byId = new Map(products.map((product) => [product.id, product]));
  const missingItems = request.itemIds.filter((id) => !byId.has(id));
  if (missingItems.length) throw new Error(`Unknown or cross-workspace item ids: ${missingItems.join(", ")}`);

  const collections = request.collectionIds.map((id) => repository.getCollection(id));
  const invalidCollections = request.collectionIds.filter((id, index) => {
    const collection = collections[index];
    return !collection || collection.workspaceId !== workspace.id;
  });
  if (invalidCollections.length) throw new Error(`Unknown or cross-workspace collection ids: ${invalidCollections.join(", ")}`);

  const committed = repository.listFieldDefinitions(workspace.id);
  const fields = committed.length ? committed : repository.inferWorkspaceSchema(workspace.id);
  const facets = repository.getWorkspaceFacets(
    workspace.id,
    fields.filter((field) => field.facetable).map((field) => field.key),
  );
  const withImages = products.filter((product) => product.images.length > 0).length;
  const withCoordinates = products.filter((product) => Number.isFinite(product.x) && Number.isFinite(product.y)).length;
  const localEmbeddingArtifactAvailable = existsSync(resolve("data/image-cache/visual-embeddings.json"));

  return researchWorkspaceManifestSchema.parse({
    version: 1,
    workspace,
    fields,
    facets,
    counts: {
      items: products.length,
      withImages,
      withCoordinates,
      byKind: countBy(products.map((product) => product.kind)),
      bySource: countBy(products.map((product) => product.source)),
      byDecision: countBy(products.map((product) => product.decision)),
    },
    selectedItems: request.itemIds.map((id) => manifestItem(byId.get(id)!)),
    selectedCollections: collections.map((collection) => ({
      id: collection!.id,
      name: collection!.name,
      description: collection!.description,
      itemIds: collection!.items.map((item) => item.itemId),
    })),
    sources: installedResearchSources(),
    constraints: request.constraints,
    budget: request.budget,
    visualIndex: {
      imagesAvailable: withImages,
      coordinatesAvailable: withCoordinates,
      localEmbeddingArtifactAvailable,
      hybridEmbeddingsMayBeAvailable: localEmbeddingArtifactAvailable && withImages > 0,
    },
  });
}
