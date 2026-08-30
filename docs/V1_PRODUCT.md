# Mosaic V1 product contract

Mosaic is a private, local-first visual research canvas. A user describes what
they want to explore, pastes links, or drops images; Mosaic collects structured
items, arranges them visually, and lets the user reuse selections with AI.

Wardrobe Atlas is the first domain profile and remains fully supported. V1 must
also support generic visual-product workspaces, with televisions as the proving
profile. The product must not claim that every website is scrapeable: broad
search is adapter-backed, direct public product pages use structured metadata or
an explicitly configured browser agent, and blocks/CAPTCHAs are reported rather
than bypassed.

## Experience principles

1. **Ask first.** The primary empty-state and header action is a single
   multimodal assistant composer accepting text, URLs, images, catalog items,
   and collections.
2. **Board first.** The visual canvas receives most of the viewport. Filters,
   runs, item details, and advanced projection controls are contextual surfaces.
3. **Progressive disclosure.** Default language is human: Explore, Collections,
   Activity, Filters, View. PCA, embeddings, adapters, and job internals stay in
   Advanced/diagnostic surfaces.
4. **Selections become reusable context.** A temporary selection tray can save
   to a collection, compare, ask AI, or create an artifact.
5. **Transparent automation.** Long or remote work exposes a compact editable
   plan, progress, source, failures, cancel, and explicit resume. Local filters
   should feel immediate.
6. **Local-first and recoverable.** User media and generated artifacts remain
   local by default. Imports preserve user state. Every background run can be
   inspected and recovered without silently restarting network work.

The visual gold standard is `docs/design/mosaic-gold-standard.png`. It is a
directional reference, not a pixel-perfect specification. Preserve its warm
off-white canvas, ink typography, restrained coral selection accent, compact
left navigation, prominent assistant, visual density, contextual collection
rail, selection tray, and minimap.

## Generic model

### Workspace

A workspace owns items, field definitions, views, collections, and runs.

- `id`, `name`, `description`
- `profile`: `clothing`, `televisions`, or `generic`
- `schemaVersion`
- `settings` JSON (currency, locale, default constraints, board preferences)
- timestamps

The legacy catalog migrates into one default `clothing` workspace without
changing product ids or user decisions.

### Item

The existing Product remains a compatibility representation during V1. Its
universal envelope is:

- identity: id, workspace, source, sourceId, canonical URL
- presentation: title/name, description, images, brand/maker
- commerce: price, original price, currency, availability and freshness
- semantics: profile/category, tags, arbitrary attributes
- user state: saved/rejected/owned compatibility decision, annotations, scores
- projection: x/y and embedding revision

Domain-specific values live in `attributes`. Clothing convenience fields stay
available until all existing code is migrated.

### Field definition

A workspace schema defines discoverable/filterable fields:

- stable key and human label
- primitive type: text, number, boolean, enum, multi-enum, date
- optional unit and semantic role
- facetable/sortable/display flags
- coverage and cardinality statistics
- source aliases and normalizer
- display order

Facet suggestions are inferred from imported data but committed as a versioned
workspace schema. A single import must not reshuffle the interface. Only fields
with meaningful coverage and cardinality become default filters.

### Collection

Collections replace hard-wired shortlist/outfit concepts without deleting their
compatibility behavior.

- manual, smart, AI-result, or generated-artifact collection
- arbitrary name, color, icon, description
- ordered item membership with optional role and notes
- optional smart FilterSpec

`Favorites` is the system collection synchronized with `decision=saved`.
Existing outfit boards migrate to regular collections with clothing roles.

### Run and artifact

The Activity surface presents a normalized view of discovery, import,
enrichment, embedding, visual scoring, and generation jobs. Existing specialized
job tables may remain; the API maps them to one `RunView` contract.

Generated images, reports, comparisons, and future try-ons are Artifacts. An
artifact records local files, prompt, input item/collection ids, generator,
status, timestamps, and provenance. V1 scaffolds this contract even when no
remote image-generation provider is configured.

## Assistant contract

The assistant returns a bounded plan containing one or more typed steps instead
of choosing exactly one wardrobe action. Supported primitives:

- filter the current workspace
- import public product URLs
- discover through supported source adapters
- enrich selected items
- find similar items using cached hybrid embeddings
- visually score a frozen candidate set
- create/update a collection
- compare/summarize selections
- compose a domain-specific set (for example an outfit)
- request a generated artifact
- clarify only when execution would otherwise be materially wrong

Codex/Luna chooses the primitives. Core operations remain deterministic local
services exposed as constrained tools. MCP is an agent interface, not the
application's persistence layer. A plan must preserve explicit user constraints,
bound remote work, reject out-of-scope ids, and treat webpages as untrusted data.

## Release boundary

V1 promises:

- visual exploration for clothing and generic product/image workspaces;
- adapter-backed discovery on supported shops;
- import from public product pages with usable structured data;
- explicit browser-agent setup for interactive extraction when available;
- dynamic facets, collections, reusable AI context, and durable activity;
- graceful unsupported/blocked outcomes, never anti-bot bypass.

V1 does not promise unattended access to every site, authenticated purchasing,
CAPTCHA solving, or automatic transmission of personal photos to a remote model.

## Acceptance journeys

1. A first-time user asks for 80 men's autumn items in M or L under CHF 200,
   sees an editable plan and streaming results, saves four items, then asks for
   similar alternatives.
2. A user pastes three unknown-shop product links. Structured pages import; any
   unsupported page produces a clear recovery action without losing successes.
3. A user creates a television workspace and imports product links. Useful TV
   facets appear without clothing controls leaking into the interface.
4. A migrated Wardrobe Atlas catalog retains all ids, decisions, references,
   outfits, images, sizes, freshness, scores, coordinates, and saved views.
5. A user selects a person photo and a clothing collection, creates a local
   Studio draft, and can later run a configured generator without reselecting
   inputs.
