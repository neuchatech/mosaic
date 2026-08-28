import type { FilterClause, FilterExpression, FilterSpec, Product } from "./catalog";

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("fr-CH");
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(normalize) : [normalize(value)];
}

function valueAtPath(product: Product, path: string): unknown {
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
    const left = Number(actual);
    const right = Number(expected);
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
  const contains = expectedValues.some((needle) =>
    actualValues.some((candidate) => candidate.includes(needle)),
  );

  if (clause.operator === "contains" || clause.operator === "in") return contains;
  return !contains;
}

function matchesExpression(product: Product, expression: FilterExpression): boolean {
  if (expression.type === "clause") return matchesClause(product, expression);
  if (expression.type === "not") return !matchesExpression(product, expression.child);
  const results = expression.children.map((child) => matchesExpression(product, child));
  return expression.conjunction === "and" ? results.every(Boolean) : results.some(Boolean);
}

export function applyFilter(products: Product[], spec: FilterSpec): Product[] {
  const filtered = products.filter((product) => {
    return matchesExpression(product, spec.where);
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
