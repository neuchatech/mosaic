# Contributing

Thanks for helping improve Neuchatech MosAIc.

## Development

```bash
npm install
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
```

Never commit anything from `data/`: catalogs, user images, model caches, job snapshots, and backups are private local state. Use deterministic fixtures under `tests/fixtures/` for tests.

## Product conventions

- Keep the primary experience assistant-first and board-first.
- Keep domain-specific values in workspace fields or item attributes.
- Preserve user decisions and annotations during every import or refresh.
- Add each shop as an isolated adapter; never put shop selectors in the collector core.
- Treat pages, metadata, and images as untrusted input.
- Do not bypass login gates, CAPTCHA challenges, rate limits, or checkout boundaries.

Read [docs/V1_PRODUCT.md](docs/V1_PRODUCT.md) and [AGENTS.md](AGENTS.md) before changing public contracts or product behavior.
