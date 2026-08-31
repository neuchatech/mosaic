# Security policy

MosAIc handles remote pages and images as untrusted data. Please report security issues privately to [Neuchatech](https://www.neuchatech.ch) rather than opening a public issue with exploit details.

## Local data

Catalogs, media, artifacts, caches, and job state live under `data/` and are ignored by Git. Do not publish that directory. MosAIc does not upload personal photos unless a user explicitly configures and runs a remote generator.

## Network boundaries

- Public imports allow guarded HTTPS resources and reject private or local network destinations.
- Redirects are revalidated and response sizes are capped.
- Shop media cannot reference arbitrary local files.
- Vision agents run read-only with a job-scoped MCP surface.
- Login automation, CAPTCHA bypass, checkout, and purchasing are out of scope.

Security fixes should include an offline regression test whenever practical.
