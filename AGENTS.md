# Neuchatech MosAIc agent guide

## Product contract

- Neuchatech MosAIc is a private, local-first visual research canvas. The legacy Wardrobe Atlas clothing profile remains compatible.
- Workspaces may contain shop products, owned objects, visual references, or generic visual items. References are context anchors and are never purchasable.
- Read `docs/V1_PRODUCT.md` before changing product behavior, public contracts, the data model, assistant routing, or the main UX. Treat `docs/design/mosaic-gold-standard.png` as the approved visual direction.
- Keep universal item fields small. Put profile-specific values in typed workspace field definitions and item attributes; do not add TV- or clothing-specific columns for each new domain.
- Collections are the reusable selection primitive. Favorites and outfit boards are compatibility views over collections, not the only supported organization model.
- The default UX is assistant-first and board-first. Developer concepts such as PCA, MCP, adapters, and raw job states belong in advanced or diagnostic surfaces.
- Filtered spatial views must be reprojected and compacted. Never hide items while retaining the full-set coordinates and large empty holes.
- Checkout, CAPTCHA handling, anti-bot bypasses, and unbounded unattended crawling are out of scope. An explicitly configured Chrome skill may perform user-like, read-only extraction with visible progress and the same safety limits.

## Preferred agent workflow

- Use the `wardrobe_atlas` MCP tools for catalog statistics, product queries, contact sheets, filter saving, and annotations.
- For a scoped visual job, start with `get_visual_job_context`, use `inspect_visual_context` only for its frozen wardrobe/reference anchors, then inspect candidates with `inspect_visual_candidate` and immediately call `record_visual_assessment`. Never score a context anchor or an ID outside the frozen candidate set.
- For an unscoped interactive manual audit, `inspect_product_image` and contact sheets remain available.
- Translate natural-language filters into the nested FilterSpec DSL. Use `scores.<name>` and `attributes.<name>` for dynamic criteria; never generate raw SQL.
- Preserve all user decisions (`saved`, `rejected`, `owned`) during imports and projection updates.
- Add each new shop as a separate adapter under `collector/adapters/`; do not put shop-specific selectors in the collector core.

## Validation

- Run `npm run typecheck` after TypeScript changes.
- Run `npm test` for changes to filters, storage, projection, collection, MCP tools, or the main interface.
- Do not test collectors against a live shop unless the user explicitly asks. Prefer saved HTML fixtures for selector tests.
