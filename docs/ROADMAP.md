# Neuchatech MosAIc — delivered roadmap

The current release covers the complete local visual-research loop.

## Foundation

- Exact availability and freshness for price, stock, and domain-specific variants.
- Persistent save, reject, and owned decisions with undo.
- Targeted refresh, durable acquisition jobs, explicit retry, cancel, and recovery.
- Compact comparison, saved views, exports, keyboard navigation, touch support, and reduced motion.

## Agentic research

- One assistant composer for public URL import, supported-shop discovery, enrichment, filters, similarity, visual scoring, collections, comparisons, and artifact drafts.
- Hard constraints are applied before visual scoring; rejected items remain excluded unless explicitly requested.
- Text, images, selected items, and collections can be reused as bounded agent context.
- Local CLIP embeddings improve visual placement while metadata remains a reliable offline fallback.

## MosAIc V1

- Assistant-first, board-first experience with contextual onboarding.
- Isolated clothing, television, and generic workspaces.
- Dynamic field definitions and facets inferred from actual workspace data.
- Collections, reusable multi-selection, unified activity, and local Studio drafts.
- Spatial hashing, viewport culling, minimap, and stable cached layouts for large catalogs.
- Project acquisition skill and documented optional Chrome recovery workflow.
- Guarded public imports, contained local media, and read-only scoped Vision agents.
- English, French, German, Italian, and Spanish UI with automatic locale detection.

## Next directions

The generative try-on and visual-composition plan lives in [GENERATIVE_TRYON.md](./GENERATIVE_TRYON.md). It preserves local drafts and requires explicit consent before any personal photo is sent to a configured remote provider.

New shops should be added through recorded offline fixtures and an adapter under `collector/adapters/`. The collector core, catalog, and UI should not gain shop-specific selectors.
