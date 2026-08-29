import { guessCategory, guessColorFamily, guessFit, guessTags } from "../collector/normalize";
import { CatalogRepository } from "../server/repository";
import { compactProjection } from "../src/projection/compact";
import { projectProducts } from "../src/projection/pca";

const repository = new CatalogRepository();
const products = repository.listProducts({ limit: 10_000 });
const improved = products.flatMap((product) => {
  if (product.kind !== "shop") return [];
  const text = `${product.name} ${product.description}`;
  const guessedCategory = guessCategory(text);
  const guessedColor = guessColorFamily(text);
  const guessedFit = guessFit(text);
  const misplacedBaggyGarment = product.category === "Accessoires"
    && guessedCategory === "Pantalons"
    && /\bbaggy\b.*(?:trouser|jean|hose|pantalon)/i.test(text);
  const next = {
    ...product,
    category: (product.category === "Autre" && guessedCategory !== "Autre") || misplacedBaggyGarment ? guessedCategory : product.category,
    colorFamily: product.colorFamily === "unknown" && guessedColor !== "unknown" ? guessedColor : product.colorFamily,
    fit: product.fit === "unknown" && guessedFit !== "unknown" ? guessedFit : product.fit,
    tags: [...new Set([...product.tags, ...guessTags(text)])],
  };
  const changed = next.category !== product.category
    || next.colorFamily !== product.colorFamily
    || next.fit !== product.fit
    || next.tags.length !== product.tags.length;
  return changed ? [next] : [];
});

repository.upsertCollectedProducts(improved);
const allProducts = repository.listProducts({ limit: 10_000 });
repository.replaceCoordinates(compactProjection(projectProducts(allProducts)));
console.log(`Normalized ${improved.length} catalog products and projected ${allProducts.length}.`);
