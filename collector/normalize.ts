import { productSchema, type Product } from "../src/domain/catalog";
import { stableWorkspaceProductId } from "../src/domain/ids";
import type { RawProduct } from "./types";

export function guessCategory(value: string): string {
  const normalized = value.toLocaleLowerCase();
  if (/chauss|shoe|schuh|sneaker|\bbaskets?\b|trainer|\bboots?\b|stiefel|stiefelette|loafer|mocassin|derby|brogue|sandale/.test(normalized)) return "Chaussures";
  if (/ceinture|\bbelts?\b|gürtel|\bsacs?\b|\bbags?\b|tasche|tote|backpack|rucksack|banane|crossbody|messenger|casquette|\bcap\b|bonnet|beanie|mütze|\bhat\b|\bhut\b|chapeau|écharpe|foulard|bandana|scarf|schal|lunettes|sunglasses|sonnenbrille|collier|necklace|kette|bracelet|armband|bague|\bring\b|portefeuille|wallet|geldbörse|chaussette|socks|socken|cravate|krawatte|\btie\b|montre|\bwatch\b|\buhr\b|gants?|gloves?|handschuh|étui/.test(normalized)) return "Accessoires";
  if (/pantalon|trouser|jean|\bshorts?\b(?![- ]sleeve)|hose\b|chino/.test(normalized)) return "Pantalons";
  if (/t-shirt|\btees?\b|langarmshirt|débardeur|tank.?top|henley/.test(normalized)) return "T-shirts";
  if (/pull|pullover|pulli|sweater|maille|knit|strick|cardigan|gilet|\bweste\b/.test(normalized)) return "Mailles";
  if (/veste|jacket|jacke|blouson|surchemise|overshirt|manteau|mantel|coat|bomber/.test(normalized)) return "Vestes";
  if (/chemise|shirt|\bhemd\b/.test(normalized)) return "Chemises";
  return "Other";
}

export function guessColorFamily(value: string): string {
  const normalized = value.toLocaleLowerCase();
  if (/brown|braun|brun|marron|chocolate|cognac|camel|caramel|tabac|tobacco|rust|rouille|tan|taupe|mocha|coffee|hazelnut|walnut|chestnut|otter|rubber|molé|\bmole\b/.test(normalized)) return "brown";
  if (/beige|cream|crème|écru|ecru|sand|sable|stone|oatmeal|ivory|off.?white|crockery|greige|grège|gold|doré|dorée|goldfarben/.test(normalized)) return "beige";
  if (/green|grün|vert|olive|khaki|kaki|army|sage|forest/.test(normalized)) return "green";
  if (/blue|blau|bleu|navy|marine|indigo|denim/.test(normalized)) return "blue";
  if (/black|schwarz|noir/.test(normalized)) return "black";
  if (/grey|gray|grau|gris|anthracite|charcoal|silver/.test(normalized)) return "grey";
  if (/white|weiß|weiss|blanc/.test(normalized)) return "white";
  return "unknown";
}

export function guessFit(value: string): string {
  const normalized = value.toLocaleLowerCase();
  if (/cropped|court|courte|raccourci|\bkurz\b|boxy/.test(normalized)) return "cropped";
  if (/wide|large|baggy|loose|weit|locker|balloon|flare/.test(normalized)) return "wide";
  if (/oversized|oversize/.test(normalized)) return "oversized";
  if (/relaxed|comfort/.test(normalized)) return "relaxed";
  if (/straight|droit|droite|gerade/.test(normalized)) return "straight";
  if (/slim|skinny|fitted|ajusté|ajustée|schmal/.test(normalized)) return "slim";
  return "unknown";
}

export function guessTags(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const tags: string[] = [];
  if (/blazer|suit|costume|tailored|tailleur|pleated|pince|darted/.test(normalized)) tags.push("tailored");
  if (/knit|maille|cable|torsad|waffle|corduroy|velours|tweed|suede|daim/.test(normalized)) tags.push("textured");
  if (/washed|faded|vintage|délav|garment.?dyed/.test(normalized)) tags.push("washed");
  if (/overshirt|surchemise|cardigan|gilet|vest|long.?sleeve|manches longues|turtleneck|col roulé/.test(normalized)) tags.push("layering");
  if (/workwear|worker|chore|cargo|fatigue|field|utility|multipocket|multi.?pocket/.test(normalized)) tags.push("utility");
  if (/loafer|mocassin|derby|\bbelts?\b|ceinture|leather|cuir|oxford|trench/.test(normalized)) tags.push("timeless");
  if (/t.?shirt|sneaker|hoodie|sweat|jean|denim|casual/.test(normalized)) tags.push("casual");
  if (/casquette|\bcap\b|bonnet|beanie|mütze|\bhat\b|chapeau/.test(normalized)) tags.push("headwear");
  if (/collier|necklace|halskette|\bkette\b|bracelet|armband|bague|\bring\b/.test(normalized)) tags.push("jewelry");
  if (/\bsacs?\b|\bbags?\b|tasche|tote|backpack|rucksack|banane|crossbody|messenger/.test(normalized)) tags.push("bags");
  if (/ceinture|\bbelts?\b|gürtel/.test(normalized)) tags.push("belts");
  if (/écharpe|foulard|bandana|scarf|schal/.test(normalized)) tags.push("scarves");
  if (/lunettes|sunglasses|sonnenbrille/.test(normalized)) tags.push("eyewear");
  return tags;
}

export function normalizeProduct(
  source: string,
  raw: RawProduct,
  workspaceId = "default-clothing",
): Product {
  const now = new Date().toISOString();
  const sourceId = raw.sourceId || new URL(raw.url).pathname;
  const descriptiveText = `${raw.name} ${raw.description ?? ""} ${raw.color ?? ""}`;
  return productSchema.parse({
    id: stableWorkspaceProductId(workspaceId, source, sourceId),
    workspaceId,
    kind: "shop",
    source,
    sourceId,
    url: raw.url,
    brand: raw.brand ?? "Unknown",
    name: raw.name,
    description: raw.description ?? "",
    price: raw.price ?? null,
    originalPrice: raw.originalPrice ?? null,
    currency: raw.currency ?? "XXX",
    // Shops often expose a very specific taxonomy ("Pantalons cargo",
    // "Vestes de mi-saison", ...). The board facets intentionally use a
    // small canonical set, so normalize the retailer category together with
    // the product copy instead of leaking shop-specific labels into the UI.
    category: guessCategory(`${raw.category ?? ""} ${descriptiveText}`),
    color: raw.color ?? "Unknown",
    colorFamily: raw.colorFamily ?? guessColorFamily(descriptiveText),
    fit: raw.fit ?? guessFit(descriptiveText),
    attributes: raw.attributes ?? {},
    materials: raw.materials ?? [],
    tags: [...new Set([...(raw.tags ?? []), ...guessTags(descriptiveText)])],
    sizes: raw.sizes ?? [],
    images: raw.images ?? [],
    available: raw.available ?? true,
    stockStatus: raw.stockStatus ?? "unknown",
    stockCheckedAt: raw.stockCheckedAt ?? null,
    priceCheckedAt: raw.priceCheckedAt ?? null,
    sizesCheckedAt: raw.sizesCheckedAt ?? null,
    decision: "unseen",
    x: .5,
    y: .5,
    scores: {},
    importedAt: now,
    updatedAt: now,
  });
}
