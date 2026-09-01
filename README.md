<p align="center">
  <img src="public/mosaic-logo.svg" alt="Neuchatech MosAIc" width="420" />
</p>

<p align="center">
  A private, local-first visual research canvas for collecting, comparing, and exploring anything.
</p>

# Neuchatech MosAIc

MosAIc turns pages, images, objects, and ideas into a compact visual map. Ask for an outcome, paste URLs, drop a moodboard, or select existing items: the research agent chooses a bounded strategy while the board keeps every result easy to explore.

It works especially well for visually driven research—clothing, furniture, televisions, cameras, references—but its workspace schema and filters adapt to the data you import.

## Highlights

- Spatial and grid views with smooth pan, zoom, viewport culling, minimap, and local CLIP-based visual similarity.
- One conversational multimodal research agent for imports, source discovery, enrichment, filtering, comparison, visual retrieval, collections, and local Studio drafts.
- Dynamic workspace fields and facets instead of a fixed clothing-only schema.
- Reusable collections, favorites, decisions with undo, saved views, comparisons, and local artifacts.
- SQLite persistence with strict workspace isolation and durable background jobs.
- Local media storage, read-only agent sandboxes, guarded public fetches, and no CAPTCHA bypass or checkout automation.
- English, French, German, Italian, and Spanish interface with automatic browser-language detection and a manual language switcher.

## Quick start

Requirements:

- Node.js 22.13 or newer
- npm
- Optional: Codex, a local OpenAI-compatible server, or OpenRouter for assistant features

```bash
git clone https://github.com/neuchatech/wardrobe-atlas.git mosaic
cd mosaic
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The local API runs at `http://localhost:8788`.

The first launch creates an empty private workspace and database under `data/`. There is no demo catalog and no default clothing size, shop, currency, or style preference. Start by asking the assistant, adding images, or pasting public product URLs.

All files under `data/` are ignored by Git. Back up `data/wardrobe-atlas.sqlite` with SQLite's backup command while the app is running; do not copy only the main database file when WAL files may be active.

## AI setup

MosAIc's deterministic board, filters, imports, CLIP index, and local services work without an AI provider. The conversational research agent supports Codex, local OpenAI-compatible inference (including LM Studio), and OpenRouter. All three use the same durable runs and workspace-scoped MosAIc tools.

Copy the example configuration if you want to change the default provider:

```bash
cp .env.example .env
```

The assistant's provider menu shows only configured options as available. **Automatic** follows `MOSAIC_AI_PROVIDER`. The **Quick**, **Balanced**, and **Deep** presets bound time, tool calls, inspected items, images, acquisitions, and collection writes; they do not silently switch providers or models.

Choose one provider:

| Provider | Fastest setup | Best for |
| --- | --- | --- |
| **Codex** | Sign in to the Codex CLI, restart MosAIc, then select **Codex** in AI settings. | The most capable agentic research path. |
| **OpenRouter** | Select **Connect OpenRouter** in AI settings and authorize the local callback. | Trying hosted tool- and vision-capable models without managing keys manually. |
| **Local API** | Start an OpenAI-compatible server such as LM Studio, configure `.env`, then select **Local API**. | Private inference on your own hardware. |

See [AI providers](docs/AI_PROVIDERS.md) for exact setup, model requirements, image support, and troubleshooting.

### Codex

1. Install and sign in to the official [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
2. Open this repository as a trusted Codex project.
3. Start a new Codex task from the repository root.
4. Run `/mcp` and confirm that the project-scoped `mosaic` server is connected. See the official [MCP guide](https://learn.chatgpt.com/docs/extend/mcp) if project configuration is disabled locally.

The repository includes `.codex/config.toml` and the project skill `.agents/skills/mosaic-research/SKILL.md`. A foreground Codex task uses explicit workspace tools (`list_workspaces`, schema, catalog, collections and imports); the app assistant launches a durable run with a stricter private tool set scoped to one workspace and budget. The skill detects which surface it is running in instead of assuming both expose identical tools.

For Chrome-assisted extraction, install and authorize a browser in the ChatGPT desktop app, then start a fresh Work or Codex task and `@`-mention it. Browser access is explicit and never silently inherited by MosAIc's background agent: Codex CLI and IDE do not have the built-in browser. See [Chrome-assisted acquisition](docs/CHROME_ACQUISITION.md) and the official [Codex browser documentation](https://learn.chatgpt.com/docs/browser).

## Agentic research

The assistant is a persistent conversation, not a one-shot command box. Every
turn creates a durable, workspace-scoped research run while retaining the prior
user requests, concise answers, selected items, collections, and artifacts as
context. The expanded composer shows a compact action recap and the final
answer; it never exposes private chain-of-thought. You can continue with a
follow-up, revisit an earlier conversation, or start a clean one.

For each turn, the selected model sees the
workspace's real fields, facets, selected items, collections, available source
capabilities, hard constraints, soft preferences, and a resource budget. It can
choose and revise its own combination of structured queries, visual retrieval,
representative samples, source imports, enrichment, inspection, collections,
and annotations. CLIP is a fast retrieval signal, not a fixed candidate list or
the final judge.

Runs stream compact events into the conversation and **Activity**, survive partial failures, and are
explicitly resumable after a restart. The app enforces workspace isolation,
hard constraints, safe media access, and budgets at the tool boundary. See
[Agentic research architecture](docs/AGENTIC_RESEARCH.md).

## Visual similarity

Open **Activity** and choose **Improve** under local visual placement. The first run downloads the quantized CLIP vision model (about 90 MB); later runs reuse the ignored local cache under `data/image-cache/`. If the model or network is unavailable, MosAIc keeps its metadata projection.

The equivalent command is:

```bash
npm run catalog:embed -- --download-model
```

## Collecting products

List installed adapters:

```bash
npm run collect -- --list-adapters
```

Collect a user-selected public result page in a visible browser:

```bash
npm run collect -- --url "https://example-shop.test/men" --headed --details 30
```

Enrich an existing catalog in bounded batches:

```bash
npm run collect -- --enrich-existing 50
```

Collectors use one page at a time, preserve a dedicated Chrome cookie profile,
and keep a human-paced per-shop cadence (at most ten requests per minute in the
CLI). A `429` pauses the affected shop, honors `Retry-After` when supplied, and
resumes automatically with bounded exponential backoff. A rejected stateless
HTML read is retried through the persistent real-Chrome session; login and
CAPTCHA challenges still stop that URL. Product pages and checkout remain on
the original shop. A conservative JSON-LD fallback is available for explicitly
chosen public pages with `--generic`; it is not an unrestricted crawler.

The app-owned browser profile lives under ignored `data/browser-sessions/`. It
is deliberately separate from your personal Chrome profile. Delete that folder
only if you intentionally want to reset the collector's shop cookies.

## Useful commands

```bash
npm run dev                 # web app + local API
npm run build               # production build
npm start                   # production web app + local API
npm run project             # recompute the compact projection
npm run catalog:embed       # update the local visual index
npm run catalog:normalize   # normalize catalog metadata
npm run collect -- --help   # collector options
npm run mcp                 # run the MCP server manually
npm run typecheck
npm run lint
npm test
```

## Roadmap

1. **Release and feedback** — publish V1, improve onboarding from real installs, and prioritize the workflows people actually use.
2. **AI reliability** — add provider evals, clearer capability reporting, stronger recovery, and better cost and latency controls.
3. **Broader discovery** — expand generic imports and adapters while keeping source behavior observable, bounded, and local-first.
4. **MosAIc Studio** — turn saved selections into optional generated compositions and try-ons with explicit provider consent.
5. **Monitoring and collaboration** — richer run history, portable workspace exports, and carefully scoped sharing without compromising the private local default.

The longer-term notes and V1 boundary are tracked in [the roadmap](docs/ROADMAP.md).

## Architecture and safety

- [Product contract](docs/V1_PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Agentic research architecture](docs/AGENTIC_RESEARCH.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [Filter DSL](docs/FILTERS.md)
- [Chrome-assisted acquisition](docs/CHROME_ACQUISITION.md)
- [Generative Studio plan](docs/GENERATIVE_TRYON.md)
- [Roadmap](docs/ROADMAP.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

MosAIc is local-first, not “scrape anything at any cost.” It does not bypass anti-bot systems, log in, purchase products, or transmit personal photos without an explicit configured action.

## License

[MIT](LICENSE). Built with care by [Neuchatech](https://www.neuchatech.ch).
