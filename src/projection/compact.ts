import type { Product } from "../domain/catalog";

type Cell = { column: number; row: number; distance: number };

/**
 * Packs projected points into the closest free grid cells. This keeps rough
 * neighbourhoods from PCA while ensuring a filtered subset fills its board
 * instead of retaining holes left by hidden products.
 */
export function compactProjection(products: Product[], aspectRatio = 1.65): Product[] {
  if (products.length === 0) return [];
  const columns = Math.max(1, Math.ceil(Math.sqrt(products.length * aspectRatio)));
  const rows = Math.max(1, Math.ceil(products.length / columns));
  const free = new Set(Array.from({ length: columns * rows }, (_, index) => index));

  return [...products]
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((product) => {
      let best: Cell | undefined;
      for (const index of free) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = columns === 1 ? .5 : column / (columns - 1);
        const y = rows === 1 ? .5 : row / (rows - 1);
        const distance = (x - product.x) ** 2 + (y - product.y) ** 2;
        if (!best || distance < best.distance) best = { column, row, distance };
      }
      if (!best) return product;
      free.delete(best.row * columns + best.column);
      return {
        ...product,
        x: columns === 1 ? .5 : .025 + (best.column / (columns - 1)) * .95,
        y: rows === 1 ? .5 : .025 + (best.row / (rows - 1)) * .91,
      };
    });
}
