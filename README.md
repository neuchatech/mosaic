# Mosaic · Wardrobe Atlas

Mosaic is a private, local-first visual research canvas. Wardrobe Atlas is its first domain profile: it turns shop results, owned garments, and visual references into one compact spatial board. Mosaic remains a selection layer; product pages and checkout stay on the original shop.

## What is included

- A compact PCA projection: filter a subset, project it again, then pack it into nearby free cells so filtered views do not retain empty holes.
- A complete nested filter DSL with `and`, `or`, `not`, arbitrary product paths, dynamic `attributes.*` fields, and vision-generated `scores.*` fields.
- SQLite persistence for products, owned garments, references, decisions with undo, views, outfits, acquisition jobs, frozen Vision candidates, and per-job assessments.
- Exact available-size filtering with independent stock, price, and size freshness timestamps.
- A serial, rate-limited Crawlee + Playwright enrichment queue with retry/cancel/recovery, a Zalando Switzerland adapter, and a conservative opt-in JSON-LD fallback.
- A compact shortlist/compare workflow, targeted refresh, local image import, outfit boards, wardrobe-gap analysis, JSON export, keyboard controls, and responsive/touch behavior.
- A local Codex MCP server for hard-constrained visual selection, mood-board and wardrobe context, cached contact sheets, structured filters, and streamed per-item reasons.

## Quickstart

Requirements: Node.js 22.13 or newer, npm, and a local Codex login for assistant features.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The local catalog API runs at `http://localhost:8788`. The board, filters, imports, and deterministic local services work without Chrome. Assistant routes use the local Codex login and degrade to a bounded heuristic plan if the structured planner is unavailable.

On a fresh demo installation, run `npm run db:seed` once before `npm run dev`.
Do not seed an existing catalog: Mosaic migrates its SQLite schema in place at
startup while preserving product ids and user decisions. Back up `data/wardrobe-atlas.sqlite`
before a major upgrade; use SQLite's backup command while the database is live
rather than copying only the main file when WAL files may be present.

The default assistant accepts a request plus URLs, images, selected items, or collections. It returns an ordered, reviewable plan before remote work. Broad discovery stays adapter-backed; public product URLs use structured metadata first.

For the strongest visual layout, open **Activity** and choose **Improve** under
“Local visual placement”. The first run downloads the quantized CLIP vision
model (about 90 MB), then indexes product images incrementally on-device. Images,
model files, and vectors stay under the ignored `data/image-cache` directory.
Later runs reuse the cache; if the model or network is unavailable, Mosaic keeps
working with its metadata projection.

## Collect a user-selected Zalando result page

```bash
npm run collect -- --url "https://fr.zalando.ch/…" --headed --details 30
```

The collector uses one browser page at a time, waits between requests, caps the number of products, and never performs account or checkout actions. Run `npm run collect -- --list-adapters` to inspect installed shops. Add another shop by implementing `ShopAdapter` under `collector/adapters/` and registering it in `collector/registry.ts`.

For a manually chosen shop page with usable Product JSON-LD, `--generic` enables the conservative fallback. It is opt-in and does not turn the app into an unattended crawler.

For pages that cannot be collected through an adapter or public structured data, Chrome-assisted acquisition is an optional, interactive recovery path in the ChatGPT desktop app. It requires a user-installed extension and a supported Computer Use rollout; it is never installed or enabled by this repository. See [`docs/CHROME_ACQUISITION.md`](docs/CHROME_ACQUISITION.md).

To add current size availability to products already in the local catalog:

```bash
npm run collect -- --enrich-existing 50
```

Run it in bounded batches. The collector preserves existing decisions, scores, images, and board coordinates while enriching detail-page fields.

## Add references

POST a reference to `http://localhost:8788/api/references` with a name and one or more image URLs or browser data URLs. Uploaded image bytes are copied under `data/media` instead of being stored in SQLite. References receive `kind: "reference"`, are included in PCA, can carry tags/colors/fits/attributes, and serve as frozen style context for Vision without becoming purchasable candidates.

## Codex integration

Open this directory as a trusted Codex project. Its project-scoped `.codex/config.toml` starts the `wardrobe_atlas` STDIO MCP server. Start a fresh Codex task after trusting the project, then use `/mcp` to confirm the tools are connected.

The repository also ships the project skill
`.agents/skills/mosaic-acquisition/SKILL.md`. A fresh Codex task can use it to
choose between a fast adapter, direct structured URL import, and an interactive
Chrome recovery path while preserving the same limits and safety rules. No
extra copy step is required when Codex trusts this project.

To enable the Chrome path, install/enable **Computer Use**, connect its Chrome
extension in the desktop app, start a fresh task, and mention `@Chrome`. This is
a visible user-level permission and cannot be silently enabled by the repository
or by the Luna process running behind Mosaic’s assistant field. The in-app Luna
planner still decides among the deterministic operations it actually has; a
desktop Codex task with the project skill can additionally decide when the
user-authorized Chrome path is necessary. Full setup and boundaries are in
[`docs/CHROME_ACQUISITION.md`](docs/CHROME_ACQUISITION.md).

The text-filter bridge calls `codex exec` with `gpt-5.6-luna` in a read-only ephemeral run and validates the result against a JSON Schema. Vision also runs in a read-only sandbox with approval policy `never`; its job-scoped MCP is the only path allowed to record one assessment at a time. The shell tool stays disabled, candidates are frozen before launch, and the repository rejects any assessment outside that hard-filtered set. Both paths use the local Codex login and require no application API key.

Vision defaults to Luna `low`; switch to `medium` in the toolbar when a nuanced mood board warrants more judgment. Each visual score and reason belongs to its job rather than overwriting the product’s durable metadata.

The assistant planner may emit several bounded steps—import, discovery, enrichment, similarity, visual scoring, collections, comparison, composition, or artifact drafting—while preserving explicit source, size, price, and count constraints. Page contents are treated as untrusted input. The planner cannot silently grant itself browser access or expand a run beyond the declared bounds.

## Useful commands

```bash
npm run dev          # web + local API
npm run build && npm start # production web + local API
npm run db:seed      # fresh/demo install only; never reseed an existing catalog
npm run project      # recompute the complete compact PCA layout
npm run catalog:embed -- --download-model # first local CLIP index (optional)
npm run catalog:embed                    # later incremental/offline runs
npm run collect -- --list-adapters
npm run catalog:normalize # improve inferred categories/colors/fits, then reproject
npm run mcp          # run the STDIO server manually
npm run typecheck
npm test
```

See `docs/ARCHITECTURE.md`, `docs/FILTERS.md`, and `docs/ROADMAP.md` for extension points, the filter contract, and the delivered sprint map.
