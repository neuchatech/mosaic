import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolvedPublicAddress = {
  address: string;
  family: 4 | 6;
};

export type PublicHostResolver = (hostname: string) => Promise<ResolvedPublicAddress[]>;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

const blockedDomainSuffixes = [
  ".local", ".localhost", ".internal", ".lan", ".home",
  ".test", ".example", ".invalid", ".onion", ".alt", ".arpa",
];

function normalizedHostname(rawHostname: string): string {
  const trimmed = rawHostname.trim().toLocaleLowerCase().replace(/\.$/, "");
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

/** Cheap synchronous validation. DNS is still validated and pinned before I/O. */
export function isPublicShopHostname(rawHostname: string): boolean {
  const hostname = normalizedHostname(rawHostname);
  if (!hostname || hostname === "localhost" || !hostname.includes(".")) return false;
  if (isIP(hostname)) return false;
  return !blockedDomainSuffixes.some((suffix) => hostname.endsWith(suffix));
}

export function isPublicIpAddress(address: string, family?: number): boolean {
  const normalized = normalizedHostname(address);
  const detected = isIP(normalized);
  if (!detected || (family && detected !== family)) return false;
  return detected === 4
    ? !blockedIpv4.check(normalized, "ipv4")
    : !blockedIpv6.check(normalized, "ipv6");
}

export const systemPublicHostResolver: PublicHostResolver = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.flatMap((row) => row.family === 4 || row.family === 6
    ? [{ address: row.address, family: row.family }]
    : []);
};

/**
 * Reject the whole host if any answer is non-public. The caller must then pin a
 * returned address into its socket lookup so DNS cannot change between the
 * check and the connection.
 */
export async function resolvePublicHostname(
  rawHostname: string,
  resolver: PublicHostResolver = systemPublicHostResolver,
): Promise<ResolvedPublicAddress[]> {
  const hostname = normalizedHostname(rawHostname);
  if (!isPublicShopHostname(hostname)) throw new Error(`Public network access does not allow host ${rawHostname}.`);
  const addresses = await resolver(hostname);
  if (!addresses.length) throw new Error(`Public host ${hostname} did not resolve to an address.`);
  const invalid = addresses.find(({ address, family }) => !isPublicIpAddress(address, family));
  if (invalid) throw new Error(`Public host ${hostname} resolved to a non-public address.`);
  return [...new Map(addresses.map((row) => [`${row.family}:${row.address}`, row])).values()];
}

/** Resolve relative URLs but retain only credential-free public HTTPS targets. */
export function normalizePublicHttpsUrl(value: string, baseUrl?: string | URL): string | null {
  try {
    const candidate = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (candidate.protocol !== "https:" || candidate.username || candidate.password) return null;
    if (!isPublicShopHostname(candidate.hostname)) return null;
    return candidate.href;
  } catch {
    return null;
  }
}
