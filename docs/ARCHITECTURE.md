# Architecture

```text
explicit shop URL
      │
      ▼
Crawlee / Playwright ── shop adapter ── normalization
                                            │
personal references ────────────────────────┤
                                            ▼
                                         SQLite
                                      ┌─────┴─────┐
                                      ▼           ▼
                               local Hono API   MCP tools
                                      │           │
                                      ▼           ▼
                              compact PCA board  Codex vision
```

The core collector knows about navigation, limits, rate control, storage, and normalization. Selectors and shop-specific JSON-LD interpretation belong exclusively to adapters. A new adapter implements `matches`, `extractListing`, and `extractDetail`.

Catalog items use a shared `Product` shape. `kind` distinguishes `shop`, `reference`, and `owned`; `source` identifies the shop or import origin. Arbitrary retailer facts live in `attributes`, while inferred visual judgments live in `scores` and normalized search labels live in `tags`.

Projection has two stages. PCA produces semantic coordinates from category, palette, fit, tags, price, and scores. The compact pass assigns each point to the closest free cell. Every filtered query repeats both stages on its own subset.
