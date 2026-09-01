# Neuchatech MosAIc roadmap

V1 covers the complete local visual-research loop: collect, normalize, map,
filter, compare, select, and revisit visual items with an optional agentic
assistant. The next work is deliberately outcome-led rather than a promise of
specific dates.

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

## 1. Release and feedback

- Publish V1 and make the first ten minutes excellent on a clean machine.
- Turn real install and research failures into focused fixes and fixtures.
- Keep the repository, upgrade path, and release notes easy to trust.

## 2. AI reliability

- Add repeatable evals across Codex, OpenRouter, and local tool-capable models.
- Make provider capabilities, progress, recovery, cost, and latency clearer.
- Improve long-run continuation without hiding partial or failed work.

## 3. Broader discovery

- Expand generic structured imports and high-value shop adapters.
- Improve source quality, deduplication, enrichment, and visual verification.
- Keep acquisition bounded, inspectable, and respectful of each source.

## 4. MosAIc Studio

- Create optional visual compositions and try-ons from people, references, and
  selected items.
- Store drafts locally and require explicit consent before personal media is
  sent to any remote provider.
- Keep Studio outside the V1 surface until it is genuinely useful. The design
  notes live in [GENERATIVE_TRYON.md](./GENERATIVE_TRYON.md).

## 5. Monitoring and collaboration

- Add richer run history, diagnostics, and portable workspace exports.
- Explore carefully scoped sharing and collaboration while retaining a private
  local-first default.
- Make collections and research trails reusable without coupling workspaces.

## Extension rule

New shops should be added through recorded offline fixtures and an adapter under `collector/adapters/`. The collector core, catalog, and UI should not gain shop-specific selectors.
