/** Small, dependency-free readers for structured data embedded in public shop HTML. */

export function jsonLdValuesFromHtml(html: string): unknown[] {
  const values: unknown[] = [];
  const scripts = /<script\b[^>]*\btype\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scripts)) {
    try {
      const parsed = JSON.parse(match[2] ?? "null");
      if (Array.isArray(parsed)) values.push(...parsed);
      else if (parsed !== null) values.push(parsed);
    } catch {
      // A malformed analytics block must not invalidate the other product data.
    }
  }
  return values;
}

/**
 * Reads JSON passed as the sole argument of repeated inline function calls.
 * The scanner is string-aware, so parentheses inside JSON strings are safe.
 */
export function jsonCallArgumentsFromHtml(html: string, marker: string): unknown[] {
  const values: unknown[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const markerIndex = html.indexOf(marker, cursor);
    if (markerIndex < 0) break;
    const open = html.indexOf("(", markerIndex + marker.length);
    if (open < 0) break;
    let depth = 0;
    let quote = "";
    let escaped = false;
    let close = -1;
    for (let index = open; index < html.length; index += 1) {
      const char = html[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"') {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) break;
    try {
      values.push(JSON.parse(html.slice(open + 1, close)));
    } catch {
      // Ignore unrelated or changed inline payloads and continue scanning.
    }
    cursor = close + 1;
  }
  return values;
}

export function visitJson(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  const record = value as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) visitJson(child, visitor);
}
