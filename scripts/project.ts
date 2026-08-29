import { CatalogRepository } from "../server/repository";
import { projectCompactCached } from "../server/projection-cache";

const repository = new CatalogRepository();
const products = repository.listProducts({ limit: 10_000 });
const updated = repository.replaceCoordinates(projectCompactCached(products));
console.log(`Projected ${updated} products with hybrid CLIP/metadata PCA when cached, metadata PCA otherwise.`);
