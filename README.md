# Wardrobe Atlas

Wardrobe Atlas is a local-first clothing catalog that turns shop results, owned garments, and visual references into one compact spatial mood board. It is intentionally a selection layer: product pages and checkout remain on the original shop.

## What is included

- A compact PCA projection: filter a subset, project it again, then pack it into nearby free cells so filtered views do not retain empty holes.
- A complete nested filter DSL with `and`, `or`, `not`, arbitrary product paths, dynamic `attributes.*` fields, and vision-generated `scores.*` fields.
- SQLite persistence for products, owned garments, references, decisions with undo, views, outfits, acquisition jobs, frozen Vision candidates, and per-job assessments.
- Exact available-size filtering with independent stock, price, and size freshness timestamps.
- A serial, rate-limited Crawlee + Playwright enrichment queue with retry/cancel/recovery, a Zalando Switzerland adapter, and a conservative opt-in JSON-LD fallback.
- A compact shortlist/compare workflow, targeted refresh, local image import, outfit boards, wardrobe-gap analysis, JSON export, keyboard controls, and responsive/touch behavior.
- A local Codex MCP server for hard-constrained visual selection, mood-board and wardrobe context, cached contact sheets, structured filters, and streamed per-item reasons.

## Start locally

```bash
npm run db:seed
npm run dev
```

The interface runs at `http://localhost:3000`; the local catalog API runs at `http://localhost:8788`.

## Collect a user-selected Zalando result page

```bash
npm run collect -- --url "https://fr.zalando.ch/…" --headed --details 30
```

The collector uses one browser page at a time, waits between requests, caps the number of products, and never performs account or checkout actions. Run `npm run collect -- --list-adapters` to inspect installed shops. Add another shop by implementing `ShopAdapter` under `collector/adapters/` and registering it in `collector/registry.ts`.

For a manually chosen shop page with usable Product JSON-LD, `--generic` enables the conservative fallback. It is opt-in and does not turn the app into an unattended crawler.

To add current size availability to products already in the local catalog:

```bash
npm run collect -- --enrich-existing 50
```

Run it in bounded batches. The collector preserves existing decisions, scores, images, and board coordinates while enriching detail-page fields.

## Add references

POST a reference to `http://localhost:8788/api/references` with a name and one or more image URLs or browser data URLs. Uploaded image bytes are copied under `data/media` instead of being stored in SQLite. References receive `kind: "reference"`, are included in PCA, can carry tags/colors/fits/attributes, and serve as frozen style context for Vision without becoming purchasable candidates.

## Codex integration

Open this directory as a trusted Codex project. Its project-scoped `.codex/config.toml` starts the `wardrobe_atlas` STDIO MCP server. Start a fresh Codex task after trusting the project, then use `/mcp` to confirm the tools are connected.

The text-filter bridge calls `codex exec` with `gpt-5.6-luna` in a read-only ephemeral run and validates the result against a JSON Schema. Vision runs as an ephemeral, auto-reviewed job-scoped agent because its MCP must persist one score at a time; the shell tool stays disabled, candidates are frozen before launch, and the repository rejects any assessment outside that hard-filtered set. Both paths use the local Codex login and require no application API key.

Vision defaults to Luna `low`; switch to `medium` in the toolbar when a nuanced mood board warrants more judgment. Each visual score and reason belongs to its job rather than overwriting the product’s durable metadata.

## Useful commands

```bash
npm run dev          # web + local API
npm run db:seed      # demo catalog
npm run project      # recompute the complete compact PCA layout
npm run collect -- --list-adapters
npm run mcp          # run the STDIO server manually
npm run typecheck
npm test
```

See `docs/ARCHITECTURE.md`, `docs/FILTERS.md`, and `docs/ROADMAP.md` for extension points, the filter contract, and the delivered sprint map.
