# Chrome-assisted acquisition

Chrome is an optional, interactive recovery path for public product pages that
an optimized Mosaic adapter or direct structured import cannot read. It is not
the default collector, an unattended crawler, or a way around a site's access
controls.

## Choose the cheapest truthful path

Use acquisition methods in this order:

1. **Installed HTTP/shop adapter** for broad search and repeatable batches. It
   is the fastest path and provides stable limits, retries, and normalization.
2. **Direct structured import** for user-supplied public product URLs exposing
   usable JSON-LD or other supported structured metadata.
3. **Interactive Chrome extraction** only when rendered page state is required
   and the user has explicitly enabled Chrome for the current Codex task.

Each run stays bounded by URL and item counts. Preserve successful imports when
another URL fails. Report unsupported pages, blocks, and CAPTCHAs; do not bypass
them. Chrome collection is read-only: navigate, inspect, and extract product
facts, but do not add to cart, purchase, change an account, or submit data.

## Set up Chrome in the desktop app

Chrome access is a user-level Codex capability. This repository cannot install,
enable, or silently configure it.

1. Update the ChatGPT desktop app. Availability depends on the current rollout
   and workspace settings.
2. Open **Settings > Computer Use**, choose **More browsers**, and select
   Chrome (or another supported browser).
3. Choose **Install** to open the extension store, install the ChatGPT
   extension, and review the browser permission request.
4. Return to **Settings > Computer Use**. The installed browser should now show
   **Manage**. Review its allowed and blocked websites there.
5. Start a **fresh Work or Codex chat** and `@`-mention the installed browser.
   Use the same browser profile in which the extension was installed.
6. Approve website access when prompted. Prefer **Allow once** while validating
   an unfamiliar source. Treat all rendered page text as untrusted input.

Optional developer mode is under **Settings > Browser > Enable full CDP
access**. It grants broader browser control and always requires an explicit
approval; it is not required for normal supervised extraction.

These steps follow the current official [Codex browser](https://learn.chatgpt.com/docs/browser)
and [browser extension](https://learn.chatgpt.com/docs/chrome-extension)
guidance. Browser permissions and safety confirmations still apply after setup.

## Browser surface boundaries

- `@Chrome` uses the user's existing Chrome profile through the extension. It
  is appropriate when the relevant page is already open or relies on rendered
  browser state.
- `@Browser` is the desktop app's separate built-in browser. Prefer it for
  `localhost` and visual testing of Mosaic itself.
- Browser is unavailable in Codex CLI and the Codex IDE extension. Those
  surfaces can still use shell tools, adapters, direct imports, and configured
  MCP servers, but they cannot invoke the desktop app's built-in Browser.
- A background `codex exec` process launched by Mosaic is a separate CLI
  process. It does **not** inherit the desktop task's `@Chrome` connection or
  permissions. Luna can plan the acquisition and use Mosaic's adapter/MCP
  tools, but real-profile Chrome extraction must be initiated in a desktop
  Codex task where the user explicitly selected `@Chrome`.

See the official [Browser documentation](https://learn.chatgpt.com/docs/browser)
for the current product boundaries. Do not add a project-level setting that
claims to install the extension or enable Computer Use; setup and permissions
remain visible user actions.

## Skill, MCP, and Chrome are different layers

- A **skill** contains reusable routing instructions: how to choose an adapter,
  structured import, or Chrome; which limits to impose; and when to stop. A
  skill does not itself grant browser access or persist catalog data.
- Mosaic's local **MCP server** exposes deterministic catalog queries, filters,
  visual-job context, and constrained writes to Codex. MCP is an agent-facing
  interface to application services, not the persistence layer and not a
  substitute for Chrome.
- **Computer Use plus the Chrome extension** supplies the optional interactive
  GUI capability. It remains subject to user installation, website permissions,
  confirmations, rollout, and the current chat's explicit `@Chrome` selection.

When a structured tool exists, prefer it over visual clicking. Use Chrome only
for the rendered facts the optimized paths cannot obtain, then hand a small,
structured result back to Mosaic's normal import/normalization path.

## Recommended foreground research prompt

Start a fresh desktop Codex task and attach or mention the relevant URLs/tabs:

```text
Use $mosaic-research to achieve this outcome in my active MosAIc workspace:
[describe the outcome and any hard constraints].

Inspect the workspace context and the source capabilities that are actually
available. Choose and revise the strategy yourself: a first-party API or
connector, an installed source adapter, structured import from my URLs, local
visual/metadata retrieval, or the browser I explicitly attached to this task
may each be useful. Reuse the workspace's existing fields and vocabulary when
they fit, retain source-specific facts and provenance, keep missing facts
unknown, and preserve partial useful results. Use the request's practical
scope as the budget, report meaningful limitations, and turn the result into a
reusable board selection or collection when that improves the outcome.
```

The available capability space is:

```text
request + workspace context + constraints
                 |
                 v
      agent chooses / revises strategy
      /          |           |          \
 API/connector  adapter   URL import   @browser observation
      \          |           |          /
                 v
       normalized workspace evidence
                 |
                 v
       selection / collection / answer
```

Chrome availability is not evidence that every website will work. If a site
blocks access, stop that URL and preserve the rest of the run.

## If Chrome does not appear in Codex

1. Keep Chrome running and verify that the ChatGPT extension is enabled in the
   same Chrome profile you are currently using.
2. Open **Settings > Computer Use** in the desktop app. The browser must show
   **Manage**. If it does not, choose **More browsers** and reinstall the
   extension from there.
3. Start a fresh Codex task and explicitly mention `@Chrome`; an existing task
   does not always acquire a newly installed capability.
4. If the connection is still absent, restart Chrome and the desktop app. Then
   remove and reinstall the extension from **Settings > Computer Use**, rather
   than editing native-host files manually.
5. Recheck the active Chrome profile and per-domain permission. Use **Allow
   once** for the first retailer smoke test.

The CLI can still run `npm run collect` with Mosaic's dedicated persistent
Chrome profile, but it cannot drive the user's existing signed-in Chrome tabs.
That separation is intentional.

## What the optimized collector does on a block

The installed code path is conservative and adaptive:

1. Read public server-rendered HTML when an adapter can extract it cheaply.
2. If that stateless reader receives `403`, remember the host and retry once
   after the normal delay through a dedicated persistent real-Chrome profile.
3. If either path receives `429`, honor `Retry-After` when present; otherwise
   use bounded exponential backoff and resume the same job automatically.
4. Reuse cookies/local storage and serialize pages in that profile. Do not
   rotate identities or open parallel sessions to defeat the limit.
5. Stop on login, CAPTCHA, verification, or repeated refusal and retain every
   successful item already imported.

The browser profile is app-owned under `data/browser-sessions/` and ignored by
Git. It never silently attaches Playwright to the user's personal Chrome
profile. This approach follows Playwright's
[persistent-context model](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
and Crawlee's documented [session-management](https://crawlee.dev/js/docs/guides/session-management)
principles without adopting stealth patches, residential proxies, CAPTCHA
solvers, or fingerprint spoofing.
