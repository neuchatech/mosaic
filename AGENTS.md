# Neuchatech MosAIc agent guide

## Product contract

- Neuchatech MosAIc is a private, local-first visual research canvas. The legacy Wardrobe Atlas clothing profile remains compatible.
- Workspaces may contain shop products, owned objects, visual references, or generic visual items. References are context anchors and are never purchasable.
- Read `docs/V1_PRODUCT.md` before changing product behavior, public contracts, the data model, assistant routing, or the main UX. Treat `docs/design/mosaic-gold-standard.png` as the approved visual direction.
- Keep universal item fields small. Put profile-specific values in typed workspace field definitions and item attributes; do not add TV- or clothing-specific columns for each new domain.
- Collections are the reusable selection primitive. Favorites and outfit boards are compatibility views over collections, not the only supported organization model.
- The default UX is assistant-first and board-first. Developer concepts such as PCA, MCP, adapters, and raw job states belong in advanced or diagnostic surfaces.
- Filtered spatial views must be reprojected and compacted. Never hide items while retaining the full-set coordinates and large empty holes.
- External actions remain capability-scoped. A connected desktop browser can provide supervised observations, while background CLI agents use only the source capabilities advertised by MosAIc.

## Preferred agent workflow

- Use the project-scoped `mosaic` MCP tools for workspace context, item queries, visual retrieval, source acquisition, collections, filters, and annotations.
- For a research run, start with `get_research_context`. Choose an adaptive strategy from the actual fields, sources, anchors, constraints, and budget; do not assume a clothing, television, shopping, or fixed planner workflow.
- Enforce hard constraints in every result-producing tool. Treat CLIP, PCA coordinates, metadata similarity, and samples as complementary retrieval signals rather than a fixed candidate universe.
- For a scoped visual job, start with `get_visual_job_context`, use `inspect_visual_context` only for its frozen wardrobe/reference anchors, then inspect candidates with `inspect_visual_candidate` and immediately call `record_visual_assessment`. Never score a context anchor or an ID outside the frozen candidate set.
- For an unscoped interactive manual audit, `inspect_product_image` and contact sheets remain available.
- Translate natural-language filters into the nested FilterSpec DSL. Use `scores.<name>` and `attributes.<name>` for dynamic criteria; never generate raw SQL.
- Preserve all user decisions (`saved`, `rejected`, `owned`) during imports and projection updates.
- Add a source-specific adapter under `collector/adapters/` only when it materially improves repeatable acquisition. Keep generic structured URL import and browser-observation import domain-neutral; do not put site selectors in the collector core.

## Validation

- Run `npm run typecheck` after TypeScript changes.
- Run `npm test` for changes to filters, storage, projection, collection, MCP tools, or the main interface.
- Do not test collectors against a live shop unless the user explicitly asks. Prefer saved HTML fixtures for selector tests.
