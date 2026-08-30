import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  normalizePublicHttpsUrl,
  resolvePublicHostname,
  systemPublicHostResolver,
  type PublicHostResolver,
  type ResolvedPublicAddress,
} from "./public-network";

const MAX_PUBLIC_HTML_BYTES = 10 * 1024 * 1024;
const MAX_PUBLIC_RESOURCE_BYTES = 25 * 1024 * 1024;

export type PublicHtmlResponse = {
  url: string;
  status: number;
  contentType: string;
  html: string;
};

export type PublicBytesResponse = {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
};

type TransportResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
  cancel(): void;
};

type PublicNetworkTestHooks = {
  resolver: PublicHostResolver;
  fetch(url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
};

let testHooks: PublicNetworkTestHooks | null = null;

/** Explicit test seam; production always uses pinned node:https sockets. */
export function setPublicNetworkTestHooksForTests(hooks: PublicNetworkTestHooks | null): void {
  testHooks = hooks;
}

function headersFromIncoming(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function testTransportResponse(response: Response): TransportResponse {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body as (ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>) | null,
    cancel() { void response.body?.cancel().catch(() => undefined); },
  };
}

async function requestPinnedHttps(
  url: URL,
  address: ResolvedPublicAddress,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<TransportResponse> {
  if (testHooks) return testTransportResponse(await testHooks.fetch(url.href, { signal, headers }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      family: address.family,
      lookup,
      signal,
      headers,
    }, resolve);
    request.once("error", reject);
    request.end();
  });
  return {
    status: response.statusCode ?? 0,
    headers: headersFromIncoming(response),
    body: response,
    cancel() { response.destroy(); },
  };
}

export async function readLimitedBody(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Public response byte limit must be a positive integer.");
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of body) {
    const chunk = Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`Public response exceeded ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPublicBytes(
  url: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    allowedHost?: (hostname: string) => boolean;
    accept?: string;
    resolver?: PublicHostResolver;
  },
): Promise<PublicBytesResponse> {
  const initialUrl = normalizePublicHttpsUrl(url);
  if (!initialUrl) throw new Error("Public network access requires a credential-free public HTTPS URL.");
  const requested = new URL(initialUrl);
  if (options.allowedHost && !options.allowedHost(requested.hostname)) {
    throw new Error(`Public network access does not allow host ${requested.hostname}.`);
  }
  const requestedMaxBytes = options.maxBytes ?? MAX_PUBLIC_RESOURCE_BYTES;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1) {
    throw new Error("Public response byte limit must be a positive integer.");
  }
  const maxBytes = Math.min(MAX_PUBLIC_RESOURCE_BYTES, requestedMaxBytes);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) controller.abort(options.signal.reason);
  else options.signal.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Public network request timed out.")), options.timeoutMs ?? 45_000);
  try {
    let current = requested;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      if (options.allowedHost && !options.allowedHost(current.hostname)) {
        throw new Error(`Public network redirect does not allow host ${current.hostname}.`);
      }
      const addresses = await resolvePublicHostname(
        current.hostname,
        options.resolver ?? testHooks?.resolver ?? systemPublicHostResolver,
      );
      // The validated answer is pinned into the socket lookup. DNS is not
      // consulted again between validation and connection.
      const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0]!;
      const response = await requestPinnedHttps(current, address, controller.signal, {
        accept: options.accept ?? "*/*",
        "accept-encoding": "identity",
        "accept-language": "fr-CH,fr;q=0.9,en;q=0.7",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        response.cancel();
        if (!location) throw new Error("Public network redirect omitted its location.");
        if (redirect === 5) throw new Error("Public network request exceeded 5 redirects.");
        const nextUrl = normalizePublicHttpsUrl(location, current);
        if (!nextUrl) throw new Error("Public network redirect requires a credential-free public HTTPS URL.");
        current = new URL(nextUrl);
        continue;
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.cancel();
        throw new Error(`Public response is too large (${contentLength} bytes).`);
      }
      try {
        return {
          url: current.href,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: await readLimitedBody(response.body, maxBytes),
        };
      } catch (error) {
        response.cancel();
        throw error;
      }
    }
    throw new Error("Public network request exceeded 5 redirects.");
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", relayAbort);
  }
}

/**
 * Conservative reader for server-rendered public product data. It carries no
 * cookies, pins DNS to a validated public address, and never retries a block.
 */
export async function fetchPublicHtml(
  url: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    allowedHost?: (hostname: string) => boolean;
    resolver?: PublicHostResolver;
  },
): Promise<PublicHtmlResponse> {
  const response = await fetchPublicBytes(url, {
    ...options,
    maxBytes: MAX_PUBLIC_HTML_BYTES,
    accept: "text/html,application/xhtml+xml;q=0.9",
  });
  return {
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    html: response.body.toString("utf8"),
  };
}
