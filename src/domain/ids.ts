import { createHash } from "node:crypto";

export function stableProductId(source: string, sourceIdOrUrl: string): string {
  const digest = createHash("sha256")
    .update(`${source}:${sourceIdOrUrl}`)
    .digest("hex")
    .slice(0, 20);
  return `${source}_${digest}`;
}

/**
 * Keep every legacy clothing ID stable while preventing the same retailer
 * identity from colliding when it is intentionally imported into another
 * workspace.
 */
export function stableWorkspaceProductId(
  workspaceId: string,
  source: string,
  sourceIdOrUrl: string,
): string {
  return workspaceId === "default-clothing"
    ? stableProductId(source, sourceIdOrUrl)
    : stableProductId(`${workspaceId}:${source}`, sourceIdOrUrl);
}
