# Wardrobe Atlas agent guide

## Product contract

- Wardrobe Atlas is a private, local-first clothing catalog and visual mood board.
- Shop products, owned garments, and visual references are first-class catalog items. References are style anchors and are never purchasable.
- Filtered spatial views must be reprojected and compacted. Never hide items while retaining the full-set coordinates and large empty holes.
- Checkout, login automation, CAPTCHA handling, anti-bot bypasses, and unattended crawling are out of scope.

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
