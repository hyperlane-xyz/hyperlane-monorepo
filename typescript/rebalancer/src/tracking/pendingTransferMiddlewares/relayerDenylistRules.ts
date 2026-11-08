import bs58 from 'bs58';
import { ethers } from 'ethers';
import { createHash } from 'node:crypto';
import { RE2JS } from 're2js';
import { bytesToHex } from 'viem';
import { z } from 'zod';

import {
  addressToBytes32,
  addressToBytesCosmos,
  addressToBytesRadix,
  isNullish,
  isValidAddressCosmos,
  padBytesToLength,
  strip0x,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { ExplorerMessage } from '../../utils/ExplorerClient.js';

import { bodyContainsAddress, parseMatchBodyAddress } from './matchBody.js';
import { normalizeMessageId } from './types.js';

// Mirrors the relayer's runtime denylist parser
// (rust/main/agents/relayer/src/msg/runtime_denylist.rs): one invalid rule
// rejects the whole file.

export const DenylistLoadFailure = {
  FetchFailed: 'fetch_failed',
  InvalidFile: 'invalid_file',
} as const;
export type DenylistLoadFailure =
  (typeof DenylistLoadFailure)[keyof typeof DenylistLoadFailure];

export class DenylistLoadError extends Error {
  constructor(
    readonly failure: DenylistLoadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DenylistLoadError';
  }
}

/** Unset fields are wildcards. Addresses and ids are lowercase bytes32 hex. */
export interface DenylistMatchRule {
  reason: string;
  expiresAt?: number;
  messageIds?: ReadonlySet<string>;
  originDomains?: ReadonlySet<number>;
  senders?: ReadonlySet<string>;
  destinationDomains?: ReadonlySet<number>;
  recipients?: ReadonlySet<string>;
  /** Tested, unanchored, against the lowercase hex body without 0x. */
  bodyRegex?: RE2JS;
}

export interface DenylistAddressRule {
  reason: string;
  expiresAt?: number;
  address: string;
  /** Set by `matchBody: true`: lowercase 20-byte hex searched in the body. */
  bodyAddress?: string;
}

export interface DenylistRules {
  matchRules: DenylistMatchRule[];
  addressRules: DenylistAddressRule[];
}

const MATCH_KEYS = {
  messageId: 'messageid',
  originDomain: 'origindomain',
  senderAddress: 'senderaddress',
  destinationDomain: 'destinationdomain',
  recipientAddress: 'recipientaddress',
  bodyRegex: 'bodyregex',
} as const;

const WILDCARD = '*';
const U32_MAX = 2 ** 32 - 1;
const TRON_ADDRESS_PREFIX = 0x41;
const TRON_ADDRESS_LENGTH = 25;
const BECH32_DATA_REGEX = /^[!-~]+1[02-9ac-hj-np-z]{6,}$/i;

// The grammar chrono's `parse_from_rfc3339` accepts, which the relayer uses.
const RFC3339_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Returns epoch milliseconds, or undefined if not an RFC 3339 timestamp. */
export function parseRfc3339(value: string): number | undefined {
  const match = RFC3339_REGEX.exec(value);
  if (!match) return undefined;

  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;

  const fields = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    offsetHour: Number(offsetHour ?? 0),
    offsetMinute: Number(offsetMinute ?? 0),
  };

  if (
    fields.month < 1 ||
    fields.month > 12 ||
    fields.day < 1 ||
    fields.day > daysInMonth(fields.year, fields.month) ||
    fields.hour > 23 ||
    fields.minute > 59 ||
    fields.second > 60 ||
    fields.offsetHour > 23 ||
    fields.offsetMinute > 59
  ) {
    return undefined;
  }

  const offsetMs =
    (sign === '-' ? -1 : 1) *
    (fields.offsetHour * 60 + fields.offsetMinute) *
    60_000;

  return (
    Date.UTC(
      fields.year,
      fields.month - 1,
      fields.day,
      fields.hour,
      fields.minute,
      fields.second,
    ) +
    Math.floor(Number(`0${fraction ?? ''}`) * 1_000) -
    offsetMs
  );
}

const nonEmptyString = (field: string) =>
  z.string().refine((value) => value.trim().length > 0, {
    message: `\`${field}\` must not be empty`,
  });

const DenylistFileSchema = z.strictObject({ rules: z.array(z.unknown()) });

const DenylistRuleSchema = z
  .strictObject({
    reason: nonEmptyString('reason'),
    addedBy: nonEmptyString('addedBy'),
    expiresAt: z
      .string()
      .refine((value) => parseRfc3339(value) !== undefined, {
        message: '`expiresAt` must be an RFC 3339 timestamp',
      })
      .nullish(),
    match: z.record(z.string(), z.unknown()).nullish(),
    address: z.string().nullish(),
    matchBody: z.boolean().optional(),
  })
  .refine((rule) => isNullish(rule.match) !== isNullish(rule.address), {
    message: 'Exactly one of `match` or `address` must be set',
  })
  .refine((rule) => rule.matchBody === undefined || !isNullish(rule.address), {
    message: '`matchBody` is only valid on an `address` rule',
  });

const DomainValueSchema = z.union([
  z.number().int().nonnegative().max(U32_MAX),
  z
    .string()
    .regex(/^\d+$/, 'domain must be a decimal integer')
    .transform(Number)
    .pipe(z.number().max(U32_MAX)),
]);
const DomainFilterSchema = z.union([
  z.literal(WILDCARD),
  DomainValueSchema.transform((value) => [value]),
  z.array(DomainValueSchema),
]);
const AddressFilterSchema = z.union([
  z.literal(WILDCARD),
  z.string().transform((value) => [value]),
  z.array(z.string()),
]);

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function verifyTronChecksum(value: string, bytes: Uint8Array): void {
  const payload = bytes.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);

  if (
    bytes[0] !== TRON_ADDRESS_PREFIX ||
    !checksum.equals(bytes.subarray(21))
  ) {
    throw new Error(
      `Tron address \`${value}\` failed its prefix or checksum check`,
    );
  }
}

function isBech32Like(value: string): boolean {
  return (
    (value === value.toLowerCase() || value === value.toUpperCase()) &&
    BECH32_DATA_REGEX.test(value)
  );
}

function decodeBech32(value: string): Uint8Array | undefined {
  if (isValidAddressCosmos(value)) return addressToBytesCosmos(value);

  // bech32m (e.g. Radix) has no validator that accepts any prefix.
  try {
    return addressToBytesRadix(value);
  } catch {
    // Not bech32m either; the caller falls back to base58 like the relayer.
    return undefined;
  }
}

/**
 * Parses an address the way the relayer's `hex_or_base58_or_bech32_to_h256`
 * does, plus its Tron checksum check, into lowercase bytes32 hex.
 */
export function parseDenylistAddress(value: string): string {
  if (value.startsWith('0x')) {
    if (
      ethers.utils.isHexString(value, 20) ||
      ethers.utils.isHexString(value, 32)
    ) {
      return bytesToHex(
        padBytesToLength(Buffer.from(strip0x(value), 'hex'), 32),
      );
    }

    throw new Error(`Invalid hex address \`${value}\``);
  }

  const bech32Bytes = isBech32Like(value) ? decodeBech32(value) : undefined;
  if (bech32Bytes) return bytesToHex(padBytesToLength(bech32Bytes, 32));

  const bytes = bs58.decodeUnsafe(value);
  if (!bytes) throw new Error(`Invalid address \`${value}\``);

  if (bytes.length === TRON_ADDRESS_LENGTH) {
    verifyTronChecksum(value, bytes);
    return bytesToHex(padBytesToLength(bytes.subarray(1, 21), 32));
  }

  if (bytes.length !== 32) {
    throw new Error(`Invalid length of base58 address \`${value}\``);
  }

  return bytesToHex(padBytesToLength(bytes, 32));
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}

function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  field: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      `${field}: ${formatZodError(result.error)}`,
    );
  }

  return result.data;
}

function parseAddressFilter(
  value: unknown,
  field: string,
): ReadonlySet<string> | undefined {
  const parsed = parseOrThrow(AddressFilterSchema, value, field);
  if (parsed === WILDCARD) return undefined;

  if (parsed.length === 0) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      `${field} is an empty list, so it would block nothing`,
    );
  }

  return new Set(parsed.map((address) => parseDenylistAddress(address)));
}

function parseDomainFilter(
  value: unknown,
  field: string,
): ReadonlySet<number> | undefined {
  const parsed = parseOrThrow(DomainFilterSchema, value, field);
  if (parsed === WILDCARD) return undefined;

  if (parsed.length === 0) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      `${field} is an empty list, so it would block nothing`,
    );
  }

  return new Set(parsed);
}

const BodyRegexSchema = z.string().nullish();

const COUNTED_REPETITION_REGEX = /^\{(0|[1-9][0-9]*)(,(0|[1-9][0-9]*)?)?\}/;
const POSIX_CLASS_REGEX = /^\[:\^?[a-z]+:\]/;
const NAMED_GROUP_OPENER_REGEX = /^\(\?(P<|<(?![=!]))/;
const FLAG_GROUP_REGEX = /^\(\?[A-Za-z-]*\)/;
const DIVERGENT_CLASS_SEQUENCES = ['&&', '--', '~~', '-['];
const MAX_GROUP_DEPTH = 60;
const NEGATED_PROPERTY_REGEX = /^\\[pP]\{\^/;

/** The code point of a `\x{...}` escape. */
function bracedHexValue(escape: string): number | undefined {
  const hex = /^\\x\{([0-9A-Fa-f]+)\}/.exec(escape)?.[1];

  return hex === undefined ? undefined : parseInt(hex, 16);
}

/** Surrogates are not Unicode scalar values, which Rust requires. */
function isSurrogateEscape(escape: string): boolean {
  const codePoint = bracedHexValue(escape);

  return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff;
}

function escapeEnd(pattern: string, index: number): number {
  const next = pattern[index + 1] ?? '';
  if (/[pPx]/.test(next) && pattern[index + 2] === '{') {
    const close = pattern.indexOf('}', index + 3);
    return close === -1 ? pattern.length : close + 1;
  }

  return /[pP]/.test(next) ? index + 3 : index + 2;
}

/**
 * Whether a pattern is one RE2 accepts and the relayer's Rust `regex` crate
 * rejects or reads differently. See {@link parseBodyRegex}.
 */
function divergesFromRelayerRegex(pattern: string): boolean {
  let inClass = false;
  let groupDepth = 0;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '\\') {
      const next = pattern[index + 1] ?? '';
      if (/[0-9Q<>]/.test(next)) return true;
      if (!inClass && /[bB]/.test(next) && pattern[index + 2] === '{') {
        return true;
      }

      const end = escapeEnd(pattern, index);
      const escape = pattern.slice(index, end);
      if (NEGATED_PROPERTY_REGEX.test(escape) || isSurrogateEscape(escape)) {
        return true;
      }
      if (
        inClass &&
        /[dDwWsSpP]/.test(next) &&
        pattern[end] === '-' &&
        pattern[end + 1] !== ']'
      ) {
        return true;
      }
      index = end;
      continue;
    }

    if (inClass) {
      if (char === ']') {
        inClass = false;
        index++;
        continue;
      }
      if (char === '[') {
        const posixClass = POSIX_CLASS_REGEX.exec(pattern.slice(index));
        if (!posixClass) return true;
        index += posixClass[0].length;
        continue;
      }
      if (
        DIVERGENT_CLASS_SEQUENCES.some((sequence) =>
          pattern.startsWith(sequence, index),
        )
      ) {
        return true;
      }
      index++;
      continue;
    }

    if (char === '[') {
      inClass = true;
      index++;
      if (pattern[index] === '^') index++;
      if (pattern[index] === ']') index++;
      continue;
    }

    if (char === '{') {
      const repetition = COUNTED_REPETITION_REGEX.exec(pattern.slice(index));
      if (!repetition) return true;
      index += repetition[0].length;
      continue;
    }

    if (char === '(') {
      const rest = pattern.slice(index);
      const flagGroup = FLAG_GROUP_REGEX.exec(rest);
      if (
        flagGroup &&
        /[*+?{]/.test(pattern[index + flagGroup[0].length] ?? '')
      ) {
        return true;
      }

      const namedGroup = NAMED_GROUP_OPENER_REGEX.exec(rest);
      if (
        namedGroup &&
        !/[A-Za-z_]/.test(pattern[index + namedGroup[0].length] ?? '')
      ) {
        return true;
      }

      groupDepth++;
      if (groupDepth > MAX_GROUP_DEPTH) return true;
    } else if (char === ')') {
      groupDepth--;
    }
    index++;
  }

  return false;
}

/** Rust's compiled-size limit, in units of the cheapest atom. */
const MAX_RELAYER_REGEX_SIZE = 10_000;

interface ScannedAtom {
  end: number;
  size: number;
}

/**
 * Size units of an escape, measured against Rust `regex` 1.10.6. `\w`, `\W`,
 * `\D` and Unicode properties cost 100, allowing 100 copies where Rust fails
 * from about 200 (`\w`) to 3,000. `\d` and `\S` cost 10, allowing 1,000
 * where Rust fails from about 2,000 and 5,500. Other escapes cost 1 like a
 * literal, allowing 10,000 where the cheapest atoms, like `.`, fail from
 * about 11,000, a margin of only 1.1x.
 */
function escapeSize(escape: string): number {
  const kind = escape[1] ?? '';
  if (/[wWDpP]/.test(kind)) return 100;
  if (/[dS]/.test(kind)) return 10;

  return 1;
}

function isNonAsciiEscape(escape: string): boolean {
  const codePoint = bracedHexValue(escape);

  return codePoint !== undefined && codePoint > 0x7f;
}

/**
 * A class costs the sum of its members. An ASCII class costs at least 2, and
 * Rust accepts at least 10,000 copies of one made of literals, ranges and
 * POSIX classes. A class that is negated, or holds a negated POSIX class or a
 * non-ASCII member, costs at least 100, as its complement or case folding can
 * be costly: `(?i)[^\x{1e00}-\x{a7ff}]` fails from 3,000 copies and a negated
 * class with 1,000 members from 100.
 */
function scanClass(pattern: string, index: number): ScannedAtom {
  let end = index + 1;
  let exotic = pattern[end] === '^';
  if (exotic) end++;
  let size = 0;
  if (pattern[end] === ']') {
    end++;
    size++;
  }
  while (end < pattern.length && pattern[end] !== ']') {
    if (pattern[end] === '\\') {
      const escape = pattern.slice(end, escapeEnd(pattern, end));
      exotic ||= isNonAsciiEscape(escape);
      size += escapeSize(escape);
      end += escape.length;
    } else if (pattern[end] === '[') {
      exotic ||= pattern.startsWith('[:^', end);
      end = pattern.indexOf(':]', end) + 2;
      size++;
    } else {
      exotic ||= pattern.charCodeAt(end) > 0x7f;
      end++;
      size++;
    }
  }

  return { end: end + 1, size: Math.max(exotic ? 100 : 2, size) };
}

function scanAtom(pattern: string, index: number): ScannedAtom {
  const char = pattern[index];
  if (char === '[') return scanClass(pattern, index);
  if (char === '\\') {
    const end = escapeEnd(pattern, index);
    return { end, size: escapeSize(pattern.slice(index, end)) };
  }

  return { end: index + 1, size: char === '|' ? 0 : 1 };
}

/**
 * Whether Rust may reject a compiled pattern for exceeding its size limit,
 * which RE2 does not have. Atoms add their size, a repetition multiplies its
 * atom or group by its largest count, and alternatives add up.
 */
function exceedsRelayerRegexSize(pattern: string): boolean {
  const groupSizes = [0];
  let lastSize = 0;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    const rest = pattern.slice(index);
    const flagGroup = FLAG_GROUP_REGEX.exec(rest);
    const repetition = COUNTED_REPETITION_REGEX.exec(rest);

    if (flagGroup) {
      index += flagGroup[0].length;
      lastSize = 0;
      continue;
    }
    if (char === '(') {
      groupSizes.push(0);
      index += /^\((\?[^:>]*[:>])?/.exec(rest)?.[0].length ?? 1;
      lastSize = 0;
      continue;
    }
    if (char === ')') {
      lastSize = groupSizes.pop() ?? 0;
      groupSizes[groupSizes.length - 1] += lastSize;
      index++;
      if (groupSizes.some((size) => size > MAX_RELAYER_REGEX_SIZE)) return true;
      continue;
    }

    let copies: number | undefined;
    if (char === '*' || char === '?') copies = 1;
    else if (char === '+') copies = 2;
    else if (char === '{' && repetition) {
      const [, min, range, max] = repetition;
      copies =
        range === undefined ? Number(min) : max ? Number(max) : Number(min) + 1;
    }

    if (copies !== undefined) {
      index += char === '{' && repetition ? repetition[0].length : 1;
      if (pattern[index] === '?') index++;
      groupSizes[groupSizes.length - 1] += lastSize * (copies - 1);
      lastSize *= copies;
    } else {
      const atom = scanAtom(pattern, index);
      lastSize = atom.size;
      groupSizes[groupSizes.length - 1] += lastSize;
      index = atom.end;
    }

    if (groupSizes.some((size) => size > MAX_RELAYER_REGEX_SIZE)) return true;
  }

  return false;
}

/**
 * Compiles `match.bodyRegex` with RE2, which like the relayer's Rust `regex`
 * crate matches in linear time. Matching is an unanchored search over the
 * lowercase hex body, so Unicode differences between the engines (RE2's
 * ASCII `\d`, `\s` and `\b`, case folding) cannot change a match.
 *
 * Syntax RE2 accepts and Rust rejects or reads differently is rejected, so a
 * file the relayer accepts with it is rejected too:
 * - `\` followed by a digit, `\Q`, `\<`, `\>`, `\b{...}` and `\B{...}`;
 * - a surrogate escape like `\x{d800}` and a negated property like
 *   `\p{^Greek}`;
 * - a `{` that does not open a counted repetition without spaces or leading
 *   zeros, like `a{,3}`, `a{ 2}` or `a{02}`;
 * - a group name not starting with a letter or `_`, and a quantifier right
 *   after a flag group like `(?i)*`;
 * - in a class: nested classes other than POSIX ones like `[:alpha:]`, `&&`,
 *   `--`, `~~`, a range ending in a class (`-[`) and a range starting at an
 *   escaped class like `[\d-z]`;
 * - groups nested deeper than {@link MAX_GROUP_DEPTH}, which keeps every
 *   accepted pattern within Rust's nesting limit.
 *
 * Rust-only syntax RE2 rejects is also rejected: `\u{...}`, the `x`, `R`
 * and `-u` flags, stacked quantifiers like `a**` or `a{2}*`, counts above
 * 1000, `\p{Script=...}`, unknown POSIX classes and group names with `.` or
 * `[`.
 *
 * Patterns that may exceed Rust's compiled-size limit, like `\pL{260}`,
 * `\w{220}` or `\D{900}`, are rejected too.
 */
function parseBodyRegex(value: unknown): RE2JS | undefined {
  const pattern = parseOrThrow(BodyRegexSchema, value, 'match.bodyRegex');
  if (isNullish(pattern)) return undefined;

  if (divergesFromRelayerRegex(pattern)) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      "match.bodyRegex uses syntax the relayer's regex engine rejects or reads differently",
    );
  }

  let regex: RE2JS;
  try {
    regex = RE2JS.compile(pattern);
  } catch (error: unknown) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      `match.bodyRegex is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (exceedsRelayerRegexSize(pattern)) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      "match.bodyRegex may exceed the relayer's regex size limit",
    );
  }

  return regex;
}

function parseMatch(
  match: Record<string, unknown>,
  reason: string,
  expiresAt: number | undefined,
): DenylistMatchRule {
  // The relayer accepts any key casing.
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(match)) {
    const lowerKey = key.toLowerCase();
    if (
      normalized.has(lowerKey) &&
      JSON.stringify(normalized.get(lowerKey)) !== JSON.stringify(value)
    ) {
      throw new DenylistLoadError(
        DenylistLoadFailure.InvalidFile,
        `Conflicting \`match\` aliases for \`${lowerKey}\``,
      );
    }
    normalized.set(lowerKey, value);
  }

  const knownKeys: ReadonlySet<string> = new Set(Object.values(MATCH_KEYS));
  for (const key of normalized.keys()) {
    if (!knownKeys.has(key)) {
      throw new DenylistLoadError(
        DenylistLoadFailure.InvalidFile,
        `Unknown \`match\` field \`${key}\``,
      );
    }
  }

  const field = (key: string) =>
    normalized.has(key) ? normalized.get(key) : WILDCARD;

  const rule: DenylistMatchRule = {
    reason,
    expiresAt,
    messageIds: parseAddressFilter(
      field(MATCH_KEYS.messageId),
      'match.messageId',
    ),
    originDomains: parseDomainFilter(
      field(MATCH_KEYS.originDomain),
      'match.originDomain',
    ),
    senders: parseAddressFilter(
      field(MATCH_KEYS.senderAddress),
      'match.senderAddress',
    ),
    destinationDomains: parseDomainFilter(
      field(MATCH_KEYS.destinationDomain),
      'match.destinationDomain',
    ),
    recipients: parseAddressFilter(
      field(MATCH_KEYS.recipientAddress),
      'match.recipientAddress',
    ),
    bodyRegex: parseBodyRegex(normalized.get(MATCH_KEYS.bodyRegex)),
  };

  if (
    !rule.messageIds &&
    !rule.originDomains &&
    !rule.senders &&
    !rule.destinationDomains &&
    !rule.recipients
  ) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      '`match` must set messageId, originDomain, senderAddress, destinationDomain or recipientAddress; otherwise it can block every message',
    );
  }

  return rule;
}

function parseAddressRule(
  value: string,
  reason: string,
  expiresAt: number | undefined,
  matchBody: boolean | undefined,
): DenylistAddressRule {
  const bodyAddress = parseMatchBodyAddress(value, matchBody);
  const address = parseDenylistAddress(value.trim());

  if (address === ZERO_ADDRESS_HEX_32) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      '`address` must not be zero',
    );
  }

  return { reason, expiresAt, address, bodyAddress };
}

function parseRule(raw: unknown, rules: DenylistRules): void {
  const rule = parseOrThrow(DenylistRuleSchema, raw, 'rule');
  const reason = `${rule.reason.trim()} (added by ${rule.addedBy.trim()})`;
  const expiresAt = isNullish(rule.expiresAt)
    ? undefined
    : parseRfc3339(rule.expiresAt);

  if (!isNullish(rule.match)) {
    rules.matchRules.push(parseMatch(rule.match, reason, expiresAt));
  } else if (!isNullish(rule.address)) {
    rules.addressRules.push(
      parseAddressRule(rule.address, reason, expiresAt, rule.matchBody),
    );
  }
}

/**
 * Parses a runtime denylist file. Throws a `DenylistLoadError` if any rule is
 * invalid. Expired rules are kept and skipped at match time.
 */
export function parseDenylistFile(text: string): DenylistRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error: unknown) {
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      `Invalid denylist JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const file = parseOrThrow(DenylistFileSchema, json, 'file');
  const rules: DenylistRules = { matchRules: [], addressRules: [] };

  file.rules.forEach((raw, index) => {
    try {
      parseRule(raw, rules);
    } catch (error: unknown) {
      const failure =
        error instanceof DenylistLoadError
          ? error.failure
          : DenylistLoadFailure.InvalidFile;
      const message = error instanceof Error ? error.message : String(error);
      throw new DenylistLoadError(
        failure,
        `Invalid denylist rule at index ${index}: ${message}`,
      );
    }
  });

  return rules;
}

function isExpired(expiresAt: number | undefined, nowMs: number): boolean {
  return expiresAt !== undefined && expiresAt <= nowMs;
}

function matchesFilter<T>(
  filter: ReadonlySet<T> | undefined,
  value: T,
): boolean {
  return filter === undefined || filter.has(value);
}

/**
 * Returns the reason of the first active rule that denies the message, like
 * the relayer: `match` rules first, then `address` rules against the sender,
 * the recipient, the warp transfer recipient (first 32 body bytes), the
 * origin tx sender and, for `matchBody` rules, anywhere in the body.
 */
export function findDenyReason(
  rules: DenylistRules,
  msg: ExplorerMessage,
  nowMs: number,
): string | undefined {
  const messageId = normalizeMessageId(msg.msg_id);
  const sender = addressToBytes32(msg.sender).toLowerCase();
  const recipient = addressToBytes32(msg.recipient).toLowerCase();
  const body = strip0x(msg.message_body).toLowerCase();

  const matchRule = rules.matchRules.find(
    (rule) =>
      !isExpired(rule.expiresAt, nowMs) &&
      matchesFilter(rule.messageIds, messageId) &&
      matchesFilter(rule.originDomains, msg.origin_domain_id) &&
      matchesFilter(rule.senders, sender) &&
      matchesFilter(rule.destinationDomains, msg.destination_domain_id) &&
      matchesFilter(rule.recipients, recipient) &&
      (rule.bodyRegex === undefined || rule.bodyRegex.test(body)),
  );
  if (matchRule) return matchRule.reason;

  const candidates = new Set([sender, recipient]);
  if (body.length >= 64) {
    candidates.add(addressToBytes32(body.slice(0, 64)).toLowerCase());
  }
  if (msg.origin_tx_sender) {
    candidates.add(addressToBytes32(msg.origin_tx_sender).toLowerCase());
  }

  return rules.addressRules.find(
    (rule) =>
      !isExpired(rule.expiresAt, nowMs) &&
      (candidates.has(rule.address) ||
        (rule.bodyAddress !== undefined &&
          bodyContainsAddress(msg.message_body, rule.bodyAddress))),
  )?.reason;
}
