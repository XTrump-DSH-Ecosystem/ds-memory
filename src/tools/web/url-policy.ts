import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_URL_LENGTH = 8192;
const ALLOWED_PORTS = new Set([80, 443]);

export type IpClassification =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'multicast'
  | 'unspecified'
  | 'reserved'
  | 'ipv4_mapped'
  | 'nat64'
  | 'six_to_four'
  | 'teredo';

export type UrlPolicyRejectReason =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'userinfo_not_allowed'
  | 'port_not_allowed'
  | 'control_character'
  | 'localhost'
  | 'loopback_address'
  | 'private_address'
  | 'link_local_address'
  | 'multicast_address'
  | 'unspecified_address'
  | 'reserved_address'
  | 'ipv4_mapped_ipv6'
  | 'nat64_address'
  | 'six_to_four_address'
  | 'teredo_address'
  | 'dns_lookup_failed'
  | 'dns_empty'
  | 'dns_non_public_address'
  | 'dns_timeout'
  | 'aborted';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly ResolvedAddress[]>;

export interface UrlPolicyOptions {
  lookup?: LookupFn;
  signal?: AbortSignal;
  dnsTimeoutMs?: number;
}

export type UrlPolicyResult =
  | {
      ok: true;
      url: URL;
      normalizedUrl: string;
      hostname: string;
      addresses: readonly string[];
    }
  | { ok: false; reason: UrlPolicyRejectReason };

interface ParsedHttpUrl {
  url: URL;
  hostname: string;
  hostKind: 'ip' | 'name';
  address?: string;
}

type ParsedHttpUrlResult =
  | { ok: true; parsed: ParsedHttpUrl }
  | { ok: false; reason: UrlPolicyRejectReason };

const defaultLookupFn: LookupFn = async (hostname, options) => {
  const records = await dnsLookup(hostname, options);
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

function stripIpBrackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIpv4Bytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

function splitIpv6Groups(text: string): number[] | null {
  if (text === '') return [];

  const rawGroups = text.split(':');
  const groups: number[] = [];
  for (let index = 0; index < rawGroups.length; index += 1) {
    const raw = rawGroups[index]!;
    if (raw === '') return null;

    if (index === rawGroups.length - 1 && raw.includes('.')) {
      const ipv4 = parseIpv4Bytes(raw);
      if (!ipv4) return null;
      groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/i.test(raw)) return null;
    groups.push(Number.parseInt(raw, 16));
  }
  return groups;
}

function ipv6ToBytes(address: string): Uint8Array | null {
  const text = stripIpBrackets(address.trim()).toLowerCase();
  if (text.length === 0 || text.includes('%')) return null;

  const firstDoubleColon = text.indexOf('::');
  if (firstDoubleColon !== text.lastIndexOf('::')) return null;

  let leftText = text;
  let rightText = '';
  if (firstDoubleColon >= 0) {
    leftText = text.slice(0, firstDoubleColon);
    rightText = text.slice(firstDoubleColon + 2);
  }

  const left = splitIpv6Groups(leftText);
  const right = splitIpv6Groups(rightText);
  if (!left || !right) return null;

  let groups: number[];
  if (firstDoubleColon < 0) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    if (left.length + right.length >= 8) return null;
    groups = [
      ...left,
      ...new Array<number>(8 - left.length - right.length).fill(0),
      ...right,
    ];
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index]!;
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function classifyIpv4(bytes: Uint8Array): IpClassification {
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  const d = bytes[3]!;

  if (a === 0 && b === 0 && c === 0 && d === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a >= 224 && a <= 239) return 'multicast';

  if (a === 0) return 'reserved';
  if (a === 100 && b >= 64 && b <= 127) return 'reserved';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'reserved';
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 192 && b === 31 && c === 196) return 'reserved';
  if (a === 192 && b === 52 && c === 193) return 'reserved';
  if (a === 192 && b === 175 && c === 48) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 240) return 'reserved';

  return 'public';
}

function isZeroRange(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function matchesBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

function classifyIpv6(bytes: Uint8Array): IpClassification {
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  const b2 = bytes[2]!;
  const b3 = bytes[3]!;
  const b4 = bytes[4]!;
  const b5 = bytes[5]!;

  if (isZeroRange(bytes, 0, 16)) return 'unspecified';
  if (isZeroRange(bytes, 0, 15) && bytes[15] === 1) return 'loopback';

  if (isZeroRange(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return 'ipv4_mapped';
  }
  if (isZeroRange(bytes, 0, 12)) return 'reserved';

  if (matchesBytes(bytes, [0x00, 0x64, 0xff, 0x9b]) && isZeroRange(bytes, 4, 12)) {
    return 'nat64';
  }
  if (matchesBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) {
    return 'nat64';
  }
  if (b0 === 0x20 && b1 === 0x02) return 'six_to_four';
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return 'teredo';

  if ((b0 & 0xfe) === 0xfc) return 'private';
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return 'link_local';
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return 'reserved';
  if (b0 === 0xff) return 'multicast';

  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return 'reserved';
  if (b0 === 0x20 && b1 === 0x01 && b2 <= 0x01) return 'reserved';
  if (b0 === 0x3f && b1 === 0xff && (b2 & 0xf0) === 0x00) return 'reserved';
  if (b0 === 0x3f && b1 === 0xfe) return 'reserved';
  if (b0 === 0x01 && b1 === 0x00 && isZeroRange(bytes, 2, 8)) return 'reserved';
  if (b0 === 0x5f) return 'reserved';

  if ((b0 & 0xe0) === 0x20) return 'public';
  return 'reserved';
}

export function classifyIpAddress(address: string): IpClassification | 'invalid' {
  const normalized = stripIpBrackets(address.trim());
  if (normalized.length === 0 || normalized.includes('%')) return 'invalid';

  const version = isIP(normalized);
  if (version === 4) {
    const bytes = parseIpv4Bytes(normalized);
    return bytes ? classifyIpv4(bytes) : 'invalid';
  }
  if (version === 6) {
    const bytes = ipv6ToBytes(normalized);
    return bytes ? classifyIpv6(bytes) : 'invalid';
  }
  return 'invalid';
}

function classificationToReason(
  classification: IpClassification | 'invalid',
): UrlPolicyRejectReason {
  switch (classification) {
    case 'loopback':
      return 'loopback_address';
    case 'private':
      return 'private_address';
    case 'link_local':
      return 'link_local_address';
    case 'multicast':
      return 'multicast_address';
    case 'unspecified':
      return 'unspecified_address';
    case 'ipv4_mapped':
      return 'ipv4_mapped_ipv6';
    case 'nat64':
      return 'nat64_address';
    case 'six_to_four':
      return 'six_to_four_address';
    case 'teredo':
      return 'teredo_address';
    case 'reserved':
      return 'reserved_address';
    case 'public':
      return 'invalid_url';
    case 'invalid':
      return 'invalid_url';
  }
}

function hasUserInfo(rawUrl: string, url: URL): boolean {
  if (url.username !== '' || url.password !== '') return true;

  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) return false;

  const rest = rawUrl.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  return authority.includes('@');
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'local' ||
    hostname.endsWith('.local') ||
    hostname === 'internal' ||
    hostname.endsWith('.internal') ||
    hostname === 'home.arpa' ||
    hostname.endsWith('.home.arpa') ||
    hostname === 'localhost.localdomain' ||
    hostname.endsWith('.localhost.localdomain')
  );
}

function looksLikeAmbiguousNumericHost(hostname: string): boolean {
  if (/^\d+$/.test(hostname)) return true;
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true;
  if (/^\d+(?:\.\d+)*$/.test(hostname)) return true;
  return /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))+$/i.test(hostname);
}

function parseHttpUrl(raw: string): ParsedHttpUrlResult {
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) {
    return { ok: false, reason: 'control_character' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'invalid_url' };
  }
  if (/\s/.test(trimmed) || trimmed.includes('\\')) {
    return { ok: false, reason: 'invalid_url' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (hasUserInfo(trimmed, url)) {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port)) {
      return { ok: false, reason: 'port_not_allowed' };
    }
  }

  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  hostname = hostname.replace(/\.+$/, '');
  if (hostname.length === 0 || hostname.includes('%')) {
    return { ok: false, reason: 'invalid_url' };
  }

  if (isIP(hostname) !== 0) {
    const classification = classifyIpAddress(hostname);
    if (classification !== 'public') {
      return { ok: false, reason: classificationToReason(classification) };
    }
    return {
      ok: true,
      parsed: { url, hostname, hostKind: 'ip', address: hostname },
    };
  }

  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: 'localhost' };
  }
  if (looksLikeAmbiguousNumericHost(hostname)) {
    return { ok: false, reason: 'reserved_address' };
  }

  return { ok: true, parsed: { url, hostname, hostKind: 'name' } };
}

function canonicalizeUrl(url: URL, hostname: string, hostKind: 'ip' | 'name'): URL {
  if (hostKind === 'name' && url.hostname.endsWith('.')) {
    url.hostname = hostname;
  }
  url.hash = '';
  return url;
}

type LookupOutcome =
  | { kind: 'ok'; records: readonly ResolvedAddress[] }
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'error' };

async function lookupWithGuards(
  lookup: LookupFn,
  hostname: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LookupOutcome> {
  if (signal?.aborted) return { kind: 'aborted' };

  let lookupPromise: Promise<readonly ResolvedAddress[]>;
  try {
    lookupPromise = Promise.resolve(
      lookup(hostname, { all: true, verbatim: true }),
    );
  } catch {
    return { kind: 'error' };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  try {
    return await new Promise<LookupOutcome>((resolve) => {
      if (signal) {
        onAbort = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) resolve({ kind: 'aborted' });
      }
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      lookupPromise.then(
        (records) => resolve({ kind: 'ok', records }),
        () => resolve({ kind: 'error' }),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 校验 web_fetch 目标：协议、端口、userinfo、IP 字面量分类，以及
 * DNS `lookup(all:true)` 返回的全部地址。任一地址非公网即拒绝。
 */
export async function validateWebFetchUrl(
  raw: string,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyResult> {
  if (options.signal?.aborted) return { ok: false, reason: 'aborted' };

  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;

  const { url, hostname, hostKind, address } = parsed.parsed;
  if (hostKind === 'ip') {
    const canonical = canonicalizeUrl(url, hostname, hostKind);
    return {
      ok: true,
      url: canonical,
      normalizedUrl: canonical.toString(),
      hostname,
      addresses: [address!],
    };
  }

  const lookup = options.lookup ?? defaultLookupFn;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  if (!Number.isInteger(dnsTimeoutMs) || dnsTimeoutMs <= 0) {
    return { ok: false, reason: 'dns_lookup_failed' };
  }

  const outcome = await lookupWithGuards(
    lookup,
    hostname,
    options.signal,
    dnsTimeoutMs,
  );
  if (outcome.kind === 'aborted') return { ok: false, reason: 'aborted' };
  if (outcome.kind === 'timeout') return { ok: false, reason: 'dns_timeout' };
  if (outcome.kind === 'error') return { ok: false, reason: 'dns_lookup_failed' };

  const records = outcome.records;
  if (!Array.isArray(records)) return { ok: false, reason: 'dns_lookup_failed' };
  if (records.length === 0) return { ok: false, reason: 'dns_empty' };

  const addresses: string[] = [];
  for (const record of records) {
    if (!record || typeof record.address !== 'string') {
      return { ok: false, reason: 'dns_lookup_failed' };
    }
    const classification = classifyIpAddress(record.address);
    if (classification === 'invalid') {
      return { ok: false, reason: 'dns_lookup_failed' };
    }
    if (classification !== 'public') {
      return { ok: false, reason: 'dns_non_public_address' };
    }
    addresses.push(record.address);
  }

  const canonical = canonicalizeUrl(url, hostname, hostKind);
  return {
    ok: true,
    url: canonical,
    normalizedUrl: canonical.toString(),
    hostname,
    addresses,
  };
}

/**
 * 同步 URL 规范化：只做协议/端口/userinfo/字面量检查，不做 DNS。
 * 用于搜索结果展示与 allowlist 精确匹配；真正的抓取前仍会做完整 DNS 校验。
 */
export function normalizeFetchableUrl(raw: string): string | null {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return null;
  return canonicalizeUrl(
    parsed.parsed.url,
    parsed.parsed.hostname,
    parsed.parsed.hostKind,
  ).toString();
}
