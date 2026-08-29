const MAX_PUBLIC_HTML_BYTES = 10 * 1024 * 1024;

export type PublicHtmlResponse = {
  url: string;
  status: number;
  contentType: string;
  html: string;
};

/**
 * Conservative HTTP reader for server-rendered public product data. It does
 * not carry cookies, log in, solve challenges, or retry blocked responses.
 */
export async function fetchPublicHtml(
  url: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    allowedHost?: (hostname: string) => boolean;
  },
): Promise<PublicHtmlResponse> {
  const requested = new URL(url);
  if (requested.protocol !== "https:") throw new Error(`Public shop fetch requires HTTPS, not ${requested.protocol}`);
  if (options.allowedHost && !options.allowedHost(requested.hostname)) {
    throw new Error(`Public shop fetch does not allow host ${requested.hostname}.`);
  }
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Public shop fetch timed out.")), options.timeoutMs ?? 45_000);
  try {
    let current = requested;
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-language": "fr-CH,fr;q=0.9,en;q=0.7",
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      if (redirect === 5) throw new Error("Public shop fetch exceeded 5 redirects.");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new Error(`Public shop redirect requires HTTPS, not ${next.protocol}`);
      if (options.allowedHost && !options.allowedHost(next.hostname)) {
        throw new Error(`Public shop redirect does not allow host ${next.hostname}.`);
      }
      current = next;
    }
    if (!response) throw new Error("Public shop returned no response.");
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_PUBLIC_HTML_BYTES) {
      throw new Error(`Public shop response is too large (${contentLength} bytes).`);
    }
    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_PUBLIC_HTML_BYTES) {
      throw new Error(`Public shop response exceeded ${MAX_PUBLIC_HTML_BYTES} bytes.`);
    }
    return {
      url: current.href,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      html,
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", relayAbort);
  }
}
