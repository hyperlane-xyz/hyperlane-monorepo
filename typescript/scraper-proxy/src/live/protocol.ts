const MESSAGE_ID_REGEX = /^[\da-fA-F]{64}$/;
const SIGNED_INTEGER_REGEX = /^-?\d+$/;
const ADDRESS_PREFIX_REGEX = /^(?:0x|\\x)/;
const UNSIGNED_INTEGER_REGEX = /^\d+$/;
const DOMAIN_LIST_REGEX = /^\d+(,\d+)*$/;
const HASH_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

export const EVENT_TYPES = [
  'dispatch',
  'delivery',
  'gas_payment',
  'merkle_tree_insertion',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type StreamRequest = {
  /** Also stream live events at zero confirmations. */
  includeZeroConfirmations?: boolean;
  confirmations?: number;
  domains?: Set<number>;
  eventType: EventType;
};
export type ClientMessage =
  | { type: 'ping' }
  | { streams: (StreamRequest | BlockStreamRequest)[]; type: 'subscribe' };
export type BlockStreamRequest = {
  eventType: 'blocks';
  includeZeroConfirmations?: never;
  domains?: Set<number>;
  confirmations?: never;
};
export const SUBSCRIPTION_TYPES = [...EVENT_TYPES, 'blocks'];
export type EventNotification = {
  domain: number;
  eventType: EventType;
  id: bigint;
};
export type ExplorerNotification = { messageId: string };
export type HeadNotification = {
  confirmedHeight: bigint;
  domain: number;
  headHeight?: bigint;
  indexedHeight?: bigint;
  indexedHash?: string;
  previousIndexedHeight?: bigint;
  previousConfirmedHeight?: bigint;
};

export function parseClientMessage(raw: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON message');
  }
  if (!isRecord(value)) throw new Error('Invalid client message');
  if (value.type === 'ping') return { type: 'ping' };
  if (value.type !== 'subscribe' || !Array.isArray(value.streams)) {
    throw new Error('Unsupported client message type');
  }
  if (
    !value.streams.length ||
    value.streams.length > SUBSCRIPTION_TYPES.length
  ) {
    throw new Error(
      `Subscribe to between 1 and ${SUBSCRIPTION_TYPES.length} streams`,
    );
  }

  const streams = value.streams.map(parseStream);
  if (
    new Set(streams.map(({ eventType }) => eventType)).size < streams.length
  ) {
    throw new Error('Duplicate eventType subscription');
  }
  return { streams, type: 'subscribe' };
}

export function parseEventNotification(
  payload: string | undefined,
): EventNotification {
  const value = parseNotification(payload, 'event');
  if (!isEventType(value.eventType)) {
    throw new Error('Invalid scraper event notification');
  }
  return {
    domain: parseDatabaseDomain(
      value.domain,
      'Invalid scraper event notification',
    ),
    eventType: value.eventType,
    id: parseId(value.id),
  };
}

export function parseExplorerNotification(
  payload: string | undefined,
): ExplorerNotification {
  const value = parseNotification(payload, 'Explorer');
  if (
    typeof value.messageId !== 'string' ||
    !MESSAGE_ID_REGEX.test(value.messageId)
  ) {
    throw new Error('Invalid scraper Explorer notification');
  }
  return { messageId: normalizeAddress(value.messageId) };
}

export function parseHeadNotification(
  payload: string | undefined,
): HeadNotification {
  const value = parseNotification(payload, 'head');
  return {
    confirmedHeight: parseId(value.confirmedHeight),
    domain: parseDatabaseDomain(
      value.domain,
      'Invalid scraper head notification',
    ),
    previousConfirmedHeight:
      value.previousConfirmedHeight === null ||
      value.previousConfirmedHeight === undefined
        ? undefined
        : parseId(value.previousConfirmedHeight),
    headHeight:
      value.headHeight == null ? undefined : parseId(value.headHeight),
    indexedHeight:
      value.indexedHeight == null ? undefined : parseId(value.indexedHeight),
    indexedHash: parseOptionalBlockHash(value.indexedHash),
    previousIndexedHeight:
      value.previousIndexedHeight == null
        ? undefined
        : parseId(value.previousIndexedHeight),
  };
}

export function parseId(value: unknown): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && UNSIGNED_INTEGER_REGEX.test(value))
  )
    return BigInt(value);
  throw new Error('id must be a non-negative integer string');
}

export function isDomain(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

export function parseDatabaseDomain(value: unknown, error: string): number {
  const stored =
    typeof value === 'string' && SIGNED_INTEGER_REGEX.test(value)
      ? Number(value)
      : value;
  if (
    typeof stored !== 'number' ||
    !Number.isInteger(stored) ||
    stored < -0x8000_0000 ||
    stored > 0xffff_ffff
  ) {
    throw new Error(error);
  }
  return stored < 0 ? stored + 0x1_0000_0000 : stored;
}

export function normalizeAddress(value: string): string {
  return `\\x${value.replace(ADDRESS_PREFIX_REGEX, '').toLowerCase()}`;
}

export function displayAddress(value: string): string {
  return `0x${normalizeAddress(value).slice(2)}`;
}

function parseStream(value: unknown): StreamRequest | BlockStreamRequest {
  if (
    !isRecord(value) ||
    (!isEventType(value.eventType) && value.eventType !== 'blocks')
  ) {
    throw new Error('Invalid eventType');
  }
  if (
    [
      'cursors',
      'streamCursorVersion',
      'afterId',
      'afterSequence',
      'afterStreamCursor',
      'allowReplay',
    ].some((key) => key in value)
  ) {
    throw new Error(
      'Agent streams are live-only; replay cursors are unsupported. Recover history through RPC.',
    );
  }
  const domains = parseDomains(value.domains);
  if (value.eventType === 'blocks') {
    if (
      value.includeZeroConfirmations !== undefined ||
      value.confirmations !== undefined
    ) {
      throw new Error('blocks supports live heads only, without confirmations');
    }
    return { eventType: 'blocks', domains };
  }
  if (
    value.includeZeroConfirmations !== undefined &&
    typeof value.includeZeroConfirmations !== 'boolean'
  ) {
    throw new Error('includeZeroConfirmations must be a boolean');
  }
  if (value.includeZeroConfirmations && !domains) {
    throw new Error('includeZeroConfirmations requires explicit domains');
  }
  return {
    ...(value.includeZeroConfirmations !== undefined
      ? { includeZeroConfirmations: value.includeZeroConfirmations }
      : {}),
    confirmations: parseConfirmations(value.confirmations, domains),
    domains,
    eventType: value.eventType,
  };
}

export function parseConfirmations(
  value: unknown,
  domains?: Set<number>,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('confirmations must be a non-negative safe integer');
  if (!domains?.size)
    throw new Error('confirmations requires explicit domains');
  return value;
}

export function parseExplorerConfirmations(
  params: URLSearchParams,
): { confirmations: number; domains: Set<number> } | undefined {
  if (!params.has('confirmations') && !params.has('domains')) return undefined;
  const count = params.get('confirmations');
  const domainList = params.get('domains');
  if (
    !count ||
    !UNSIGNED_INTEGER_REGEX.test(count) ||
    !domainList ||
    !DOMAIN_LIST_REGEX.test(domainList)
  )
    throw new Error('Expected confirmations=N&domains=domain,...');
  const domains = new Set(domainList.split(',').map(Number));
  if (![...domains].every(isDomain)) throw new Error('Invalid domains');
  const confirmations = parseConfirmations(Number(count), domains);
  if (confirmations === undefined) throw new Error('Missing confirmations');
  return { confirmations, domains };
}

export function parseMessageId(value: string): string {
  if (!/^(?:0x|\\x)?[\da-fA-F]{64}$/.test(value))
    throw new Error('Expected a 32-byte message ID');
  return normalizeAddress(value);
}

/** Absent = global feed; empty = block/rollback updates only. */
export function parseExplorerMessageIds(
  params: URLSearchParams,
): Set<string> | undefined {
  const value = params.get('messageIds');
  if (value === null) return undefined;
  if (value === '') return new Set();
  const ids = value.split(',');
  if (ids.length > 50)
    throw new Error('messageIds must contain at most 50 valid message IDs');
  return new Set(ids.map(parseMessageId));
}

export function parseExplorerDiagnostics(
  params: URLSearchParams,
  ids?: Set<string>,
): boolean {
  const flag = params.get('diagnostics');
  if (flag === null || flag === 'false') return false;
  if (flag !== 'true' || !ids?.size)
    throw new Error('Expected diagnostics=true with explicit messageIds');
  return true;
}

export function parseExplorerBlocks(params: URLSearchParams): boolean {
  const value = params.get('blocks');
  if (value === null || value === 'false') return false;
  if (value !== 'true') throw new Error('Expected blocks=true');
  return true;
}

function parseDomains(value: unknown): Set<number> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || !value.every(isDomain)) {
    throw new Error('domains must contain valid domain IDs');
  }
  return new Set(value);
}

export function parseOptionalBlockHash(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HASH_HEX_REGEX.test(value)) {
    return undefined;
  }
  return `0x${value.toLowerCase()}`;
}

export function isEventType(value: unknown): value is EventType {
  return EVENT_TYPES.some((eventType) => eventType === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNotification(
  payload: string | undefined,
  kind: string,
): Record<string, unknown> {
  if (!payload) throw new Error(`Missing scraper ${kind} notification payload`);
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error(`Invalid scraper ${kind} notification JSON`);
  }
  if (!isRecord(value)) throw new Error(`Invalid scraper ${kind} notification`);
  return value;
}
