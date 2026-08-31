import type { FilterClause, FilterExpression, FilterSpec, Product } from "./catalog";

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("fr-CH");
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(normalize) : [normalize(value)];
}

const semanticAliases: Array<{ signals: string[]; aliases: string }> = [
  { signals: ["knit", "knitted", "strick", "maille", "jumper", "sweater", "cardigan", "pullover", "ribbed", "cable knit"], aliases: "maille mailles tricot knit knitted strick pull sweater jumper cardigan" },
  { signals: ["textur", "ribbed", "côtel", "cable", "chunky", "bouclé", "boucle", "tweed", "corduroy", "velour", "velvet", "fleece", "sherpa", "suede", "daim", "strick", "knit", "maille", "pleated", "plissé"], aliases: "texture textured texturé texturée texturisé relief matière" },
  { signals: ["baggy", "wide", "loose", "large", "relaxed", "oversized", "ample"], aliases: "baggy wide loose large relaxed oversized ample oversize" },
  { signals: ["cropped", "crop", "courte", "court", "short jacket"], aliases: "cropped crop court courte raccourci" },
  { signals: ["leather", "cuir", "suede", "daim"], aliases: "leather cuir suede daim" },
  { signals: ["wool", "wolle", "laine", "merino", "mohair"], aliases: "wool laine wolle merino mohair" },
  { signals: ["linen", "leinen", "lin"], aliases: "linen lin leinen" },
  { signals: ["cotton", "baumwolle", "coton"], aliases: "cotton coton baumwolle" },
  { signals: ["brown", "brun", "marron"], aliases: "brown brun marron" },
  { signals: ["beige", "cream", "ecru", "écru"], aliases: "beige cream crème ecru écru" },
  { signals: ["green", "vert", "olive", "khaki", "kaki"], aliases: "green vert olive khaki kaki" },
  { signals: ["blue", "bleu", "navy", "denim"], aliases: "blue bleu navy marine denim" },
  { signals: ["black", "noir"], aliases: "black noir" },
  { signals: ["grey", "gray", "gris", "charcoal"], aliases: "grey gray gris charcoal anthracite" },
  { signals: ["white", "blanc", "ivory"], aliases: "white blanc ivory ivoire" },
];

function searchableText(product: Product): string {
  const attributes = Object.values(product.attributes).flatMap((value) => Array.isArray(value) ? value : [value]);
  const base = [
    product.brand, product.name, product.description, product.category, product.color, product.colorFamily,
    product.fit, ...product.materials, ...product.tags, ...attributes,
  ].filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean").join(" ");
  const normalizedBase = normalize(base);
  const aliases = semanticAliases
    .filter((group) => group.signals.some((signal) => normalizedBase.includes(signal)))
    .map((group) => group.aliases);
  return `${base} ${aliases.join(" ")}`;
}

function valueAtPath(product: Product, path: string): unknown {
  if (path === "searchText") return searchableText(product);
  if (path === "discountPercent") {
    if (product.price === null || product.originalPrice === null || product.originalPrice === 0) return null;
    return ((product.originalPrice - product.price) / product.originalPrice) * 100;
  }

  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, product);
}

function matchesClause(product: Product, clause: FilterClause): boolean {
  const actual = valueAtPath(product, clause.field);
  const expected = clause.value;

  if (clause.operator === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (clause.operator === "missing") return actual === undefined || actual === null || actual === "";
  if (clause.operator === "between") {
    if (actual === undefined || actual === null || actual === "") return false;
    const bounds = Array.isArray(expected) ? expected.map(Number) : [];
    return bounds.length === 2 && Number(actual) >= bounds[0] && Number(actual) <= bounds[1];
  }

  if (clause.operator === "gte" || clause.operator === "lte") {
    if (actual === undefined || actual === null || actual === "") return false;
    let left = Number(actual);
    let right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      left = typeof actual === "string" ? Date.parse(actual) : Number.NaN;
      right = typeof expected === "string" ? Date.parse(expected) : Number.NaN;
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return clause.operator === "gte" ? left >= right : left <= right;
  }

  if (clause.operator === "eq" || clause.operator === "neq") {
    const equal = typeof expected === "boolean"
      ? actual === expected
      : normalize(actual) === normalize(expected);
    return clause.operator === "eq" ? equal : !equal;
  }

  const actualValues = list(actual);
  const expectedValues = list(expected);
  const substringMatch = expectedValues.some((needle) =>
    actualValues.some((candidate) => candidate.includes(needle)),
  );
  const exactMatch = expectedValues.some((expectedValue) =>
    actualValues.some((actualValue) => actualValue === expectedValue),
  );

  if (clause.operator === "contains") return substringMatch;
  if (clause.operator === "not_contains") return !substringMatch;
  if (clause.operator === "in") return exactMatch;
  return !exactMatch;
}

export function matchesFilterExpression(product: Product, expression: FilterExpression): boolean {
  if (expression.type === "clause") return matchesClause(product, expression);
  if (expression.type === "not") return !matchesFilterExpression(product, expression.child);
  const results = expression.children.map((child) => matchesFilterExpression(product, child));
  return expression.conjunction === "and" ? results.every(Boolean) : results.some(Boolean);
}

export function applyFilter(products: Product[], spec: FilterSpec): Product[] {
  const filtered = products.filter((product) => {
    return matchesFilterExpression(product, spec.where);
  });

  if (spec.sort) {
    const { field, direction } = spec.sort;
    const multiplier = direction === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const left = valueAtPath(a, field);
      const right = valueAtPath(b, field);
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * multiplier;
    });
  }

  return filtered.slice(0, spec.limit);
}
