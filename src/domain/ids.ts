import { createHash } from "node:crypto";

export function stableProductId(source: string, sourceIdOrUrl: string): string {
  const digest = createHash("sha256")
    .update(`${source}:${sourceIdOrUrl}`)
    .digest("hex")
    .slice(0, 20);
  return `${source}_${digest}`;
}
