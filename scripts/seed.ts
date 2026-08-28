import { seedProducts } from "../src/catalog/seed";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";
import { CatalogRepository } from "../server/repository";

const repository = new CatalogRepository();
const count = repository.upsertProducts(compactProjection(projectProducts(seedProducts)));
console.log(`Seeded ${count} products.`);
