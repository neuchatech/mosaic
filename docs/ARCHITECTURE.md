# Mosaic V1 architecture

```text
assistant request ── bounded typed plan ── deterministic executor
                                               │
explicit URLs ─────── structured import ───────┤
adapter search ── Crawlee / Playwright ────────┤
optional @Chrome ── read-only extraction ──────┤
personal references ───────────────────────────┤
                                               ▼
                                     normalization + media
                                               │
                                               ▼
                                            SQLite
                                      ┌────────┼─────────┐
                                      ▼        ▼         ▼
                                local API   MCP tools   jobs
                                      │        │         │
                                      └────────┴────┬────┘
                                                   ▼
                                      compact visual board
```

## Service boundaries

The core collector knows about navigation, limits, rate control, recovery, and
normalization. Selectors and shop-specific interpretation belong exclusively to
adapters. A new searchable source implements `ShopAdapter`; direct public pages
may instead use the conservative structured-data importer. Both paths write
through the same repository services and preserve prior user decisions.

Chrome-assisted acquisition is optional and interactive. It can inspect
rendered public product facts when optimized paths fail, but it is not silently
enabled by repository configuration and it never bypasses CAPTCHAs or access
controls. See `docs/CHROME_ACQUISITION.md`.

Catalog items use a shared `Product` shape. `kind` distinguishes `shop`, `reference`, and `owned`; `source` identifies the shop or import origin. Arbitrary retailer facts live in `attributes`, while inferred visual judgments live in `scores` and normalized search labels live in `tags`.

Projection has two stages. PCA consumes a cached hybrid vector: an L2-normalized
CLIP image embedding weighted at 68% and the normalized metadata feature block
weighted at 32%. Column scaling is deliberately disabled for hybrid vectors so
those weights survive PCA. Until an image has been indexed, its metadata-only
vector remains usable. The compact pass grows and packs item rectangles around
the projected coordinates; every filtered query recomputes the projection and
packing for its own subset instead of leaving holes from the full catalog.

## Assistant planning

The composer sends text plus bounded URL, image, item, and collection context to
the local assistant planner. Luna returns an ordered plan with at most 12 typed
steps. A heuristic planner covers the same contract when Codex is unavailable.
Every network-facing step declares a count, and dependency references may point
only to earlier steps.

Supported primitives are:

- local filter;
- import supplied URLs;
- adapter-backed discovery;
- bounded enrichment;
- cached hybrid similarity;
- visual scoring over a frozen candidate set;
- collection create/update operations;
- compare or summarize;
- clothing outfit or generic domain composition;
- artifact draft or configured generation request;
- clarification when proceeding would be materially wrong.

The planner preserves explicit source, size, price, and count constraints. It
rejects item IDs, collection IDs, and URLs outside the request scope. A legacy
top-level `action` and effective constraint fields remain for MVP clients.

The planner never mutates state directly. The HTTP executor validates the
selected primitive again and invokes deterministic local services. Immediate
steps return their real scoped result. A discovery followed by an artifact is
persisted as a queued continuation and is resumed after restart; the artifact is
only filled with products that were actually imported. Other discovery-dependent
steps return an explicit pending continuation instead of pretending that an empty
collection or comparison succeeded. Mutable visual candidates are frozen before
agent scoring. Partial acquisition success is durable; a failed URL or blocked
source does not erase completed imports.

## Agent integration: skill versus MCP

A **skill** is procedural knowledge. It tells Codex or Luna how to route a
request, which constrained tools to call, and when to stop or clarify. A skill
does not provide transport, browser permission, or application persistence.

The local **MCP server** is an agent interface over Mosaic services. It exposes
typed catalog queries and carefully scoped actions; it is not SQLite itself and
must not become an alternate persistence implementation. Server-side validation
remains authoritative even when an agent chose the tool sequence.

Desktop **Computer Use/Chrome** is a third, optional layer for visual interaction
with the user's browser. It requires visible user installation, permissions, and
an explicit browser mention in a fresh task. For localhost UI testing, use the
desktop app's built-in Browser instead. Neither Browser nor Chrome is implied by
the project MCP configuration.

## Trust and execution rules

- User constraints outrank defaults; a source must never be silently replaced.
- Prompts, URLs, HTML, JSON-LD strings, screenshots, and page instructions are
  untrusted data, not agent instructions.
- Broad discovery uses installed adapters. Unknown sources require supplied
  public URLs or a clarification/recovery path.
- Visual scoring accepts only a frozen candidate set and bounded top-N.
- References are context anchors, never purchasable candidates.
- Checkout, account mutation, CAPTCHA solving, anti-bot bypass, and unbounded
  unattended crawling stay outside Mosaic V1.
