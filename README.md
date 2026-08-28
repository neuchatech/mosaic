# Wardrobe Atlas

Wardrobe Atlas is a local-first clothing catalog that turns shop results, owned garments, and visual references into one compact spatial mood board. It is intentionally a selection layer: product pages and checkout remain on the original shop.

## What is seeded

- A compact PCA projection: filter a subset, project it again, then pack it into nearby free cells so filtered views do not retain empty holes.
- A complete nested filter DSL with `and`, `or`, `not`, arbitrary product paths, dynamic `attributes.*` fields, and vision-generated `scores.*` fields.
- SQLite persistence for products, references, decisions, coordinates, imports, and saved filters.
- A rate-limited Crawlee + Playwright collector with a Zalando Switzerland adapter and a conservative JSON-LD fallback.
- A local Codex MCP server for search, contact-sheet vision review, annotations, and filter creation.
- An optional UI-to-Codex bridge that runs `gpt-5.6-luna` in read-only, ephemeral mode and validates its answer against a JSON Schema before saving it.

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

## Add references

POST a reference to `http://localhost:8788/api/references` with a name and one or more image paths/URLs. References receive `kind: "reference"`, are included in PCA, and can carry the same tags, colors, fits, attributes, and vision scores as shop products.

## Codex integration

Open this directory as a trusted Codex project. Its project-scoped `.codex/config.toml` starts the `wardrobe_atlas` STDIO MCP server. Start a fresh Codex task after trusting the project, then use `/mcp` to confirm the tools are connected.

The UI’s natural-language field calls `codex exec` with `gpt-5.6-luna`, a read-only sandbox, no shell tool, and a strict output schema. This uses the local Codex login; it does not require an application API key. The MCP path is also available for larger interactive jobs such as: “build contact sheets for all jackets, score how cropped they look, then save a filter above 75.”

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

See `docs/ARCHITECTURE.md` and `docs/FILTERS.md` for extension points and the filter contract.
