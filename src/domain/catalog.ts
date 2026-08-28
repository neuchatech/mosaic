import { z } from "zod";

export const decisionSchema = z.enum(["unseen", "saved", "rejected", "owned"]);

export const stockStatusSchema = z.enum([
  "unknown",
  "in_stock",
  "out_of_stock",
  "not_applicable",
]);

export const productSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["shop", "reference", "owned"]).default("shop"),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  url: z.string().url(),
  brand: z.string().default("Unknown"),
  name: z.string().min(1),
  description: z.string().default(""),
  price: z.number().nonnegative().nullable(),
  originalPrice: z.number().nonnegative().nullable().default(null),
  currency: z.string().length(3).default("CHF"),
  category: z.string().default("Autre"),
  color: z.string().default("Inconnue"),
  colorFamily: z.string().default("unknown"),
  fit: z.string().default("unknown"),
  attributes: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ).default({}),
  materials: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  annotations: z.record(z.string(), z.string()).default({}),
  sizes: z.array(z.string()).default([]),
  images: z.array(z.string()).default([]),
  available: z.boolean().default(true),
  stockStatus: stockStatusSchema.default("unknown"),
  stockCheckedAt: z.string().datetime().nullable().default(null),
  priceCheckedAt: z.string().datetime().nullable().default(null),
  sizesCheckedAt: z.string().datetime().nullable().default(null),
  decision: decisionSchema.default("unseen"),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
  scores: z.record(z.string(), z.number()).default({}),
  importedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

type ParsedProduct = z.infer<typeof productSchema>;

// Keep direct Product object literals written before the freshness fields source-compatible.
// productSchema.parse() still materializes every default at runtime.
export type Product = Omit<
  ParsedProduct,
  "annotations" | "stockStatus" | "stockCheckedAt" | "priceCheckedAt" | "sizesCheckedAt"
> & Partial<Pick<
  ParsedProduct,
  "annotations" | "stockStatus" | "stockCheckedAt" | "priceCheckedAt" | "sizesCheckedAt"
>>;
export type ProductDecision = z.infer<typeof decisionSchema>;
export type StockStatus = z.infer<typeof stockStatusSchema>;

export const comparisonOperatorSchema = z.enum([
  "eq",
  "neq",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "gte",
  "lte",
  "between",
  "exists",
  "missing",
]);

export const filterClauseSchema = z.object({
  type: z.literal("clause").default("clause"),
  field: z.string().min(1),
  operator: comparisonOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number()), z.null()]).optional(),
});

export type FilterExpression =
  | z.infer<typeof filterClauseSchema>
  | { type: "group"; conjunction: "and" | "or"; children: FilterExpression[] }
  | { type: "not"; child: FilterExpression };

export const filterExpressionSchema: z.ZodType<FilterExpression> = z.lazy(() =>
  z.union([
    filterClauseSchema,
    z.object({
      type: z.literal("group"),
      conjunction: z.enum(["and", "or"]),
      children: z.array(filterExpressionSchema),
    }),
    z.object({
      type: z.literal("not"),
      child: filterExpressionSchema,
    }),
  ]),
);

export const filterSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  where: filterExpressionSchema.default({ type: "group", conjunction: "and", children: [] }),
  sort: z
    .object({
      field: z.string().min(1),
      direction: z.enum(["asc", "desc"]).default("desc"),
    })
    .optional(),
  limit: z.number().int().positive().max(5000).default(500),
});

export type FilterSpec = z.infer<typeof filterSpecSchema>;
export type FilterClause = z.infer<typeof filterClauseSchema>;

export const productPatchSchema = z.object({
  decision: decisionSchema.optional(),
  tags: z.array(z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  scores: z.record(z.string(), z.number().min(0).max(100)).optional(),
  fit: z.string().optional(),
  colorFamily: z.string().optional(),
  attributes: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ).optional(),
});

export type ProductPatch = z.infer<typeof productPatchSchema>;
