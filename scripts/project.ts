import { CatalogRepository } from "../server/repository";
import { projectProducts } from "../src/projection/pca";
import { compactProjection } from "../src/projection/compact";

const repository = new CatalogRepository();
const products = repository.listProducts({ limit: 10_000 });
const updated = repository.replaceCoordinates(compactProjection(projectProducts(products)));
console.log(`Projected ${updated} products with PCA.`);
