export const EVENT_TYPES = [
  'dispatch',
  'delivery',
  'gas_payment',
  'merkle_tree_insertion',
] as const;
export const SEQUENCED_EVENT_TYPES = [
  'dispatch',
  'merkle_tree_insertion',
] as const;

const CURSOR_ADDRESS = /^(?:0x|\\x)?(?:[\da-fA-F]{40}|[\da-fA-F]{64})$/;

export type EventType = (typeof EVENT_TYPES)[number];
export type SequencedEventType = (typeof SEQUENCED_EVENT_TYPES)[number];
export type SequenceCursor = {
  address: string;
  afterSequence?: bigint;
  domain: number;
};
export type StreamRequest = {
  cursors?: SequenceCursor[];
  domains?: Set<number>;
  eventType: EventType;
};
export type ClientMessage =
  | { type: 'ping' }
  | { streams: StreamRequest[]; type: 'subscribe' };
export type EventNotification = {
  domain: number;
  eventType: EventType;
  id: bigint;
};
export type ExplorerNotification = { messageId: string };

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
  if (!value.streams.length || value.streams.length > EVENT_TYPES.length) {
    throw new Error(`Subscribe to between 1 and ${EVENT_TYPES.length} streams`);
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
  if (!payload) throw new Error('Missing scraper event notification payload');
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('Invalid scraper event notification JSON');
  }
  if (
    !isRecord(value) ||
    !isEventType(value.eventType) ||
    !isDomain(value.domain)
  ) {
    throw new Error('Invalid scraper event notification');
  }
  return {
    domain: value.domain,
    eventType: value.eventType,
    id: parseId(value.id),
  };
}

export function parseExplorerNotification(
  payload: string | undefined,
): ExplorerNotification {
  if (!payload)
    throw new Error('Missing scraper Explorer notification payload');
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('Invalid scraper Explorer notification JSON');
  }
  if (
    !isRecord(value) ||
    typeof value.messageId !== 'string' ||
    !/^[\da-fA-F]{64}$/.test(value.messageId)
  ) {
    throw new Error('Invalid scraper Explorer notification');
  }
  return { messageId: normalizeAddress(value.messageId) };
}

export function parseId(value: unknown): bigint {
  return parseInteger(value, 0, 'id must be a non-negative integer string');
}

export function isDomain(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

export function normalizeAddress(value: string): string {
  return `\\x${value.replace(/^(?:0x|\\x)/, '').toLowerCase()}`;
}

export function normalizeSequenceAddress(value: string): string {
  const normalized = normalizeAddress(value);
  const twentyBytePadding = `\\x${'00'.repeat(12)}`;
  return normalized.length === 66 && normalized.startsWith(twentyBytePadding)
    ? `\\x${normalized.slice(twentyBytePadding.length)}`
    : normalized;
}

export function displayAddress(value: string): string {
  return `0x${normalizeAddress(value).slice(2)}`;
}

function parseStream(value: unknown): StreamRequest {
  if (!isRecord(value) || !isEventType(value.eventType)) {
    throw new Error('Invalid eventType');
  }
  if (value.afterId !== undefined) {
    throw new Error('afterId is unsupported; use native sequence cursors');
  }

  let domains: Set<number> | undefined;
  if (value.domains !== undefined) {
    if (
      !Array.isArray(value.domains) ||
      !value.domains.length ||
      !value.domains.every(isDomain)
    ) {
      throw new Error('domains must contain valid domain IDs');
    }
    domains = new Set(value.domains);
  }

  let cursors: SequenceCursor[] | undefined;
  if (value.cursors !== undefined) {
    if (!isSequencedEventType(value.eventType)) {
      throw new Error('cursors are only supported for sequenced streams');
    }
    if (!Array.isArray(value.cursors) || !value.cursors.length) {
      throw new Error('cursors must be a non-empty array');
    }
    cursors = value.cursors.map(parseSequenceCursor);
    const keys = cursors.map(({ address, domain }) => `${domain}:${address}`);
    if (new Set(keys).size < keys.length)
      throw new Error('Duplicate sequence cursor');
    const cursorDomains = new Set(cursors.map(({ domain }) => domain));
    if (
      domains &&
      (domains.size !== cursorDomains.size ||
        [...domains].some((domain) => !cursorDomains.has(domain)))
    ) {
      throw new Error('domains must exactly match cursor domains');
    }
    domains ??= cursorDomains;
  }
  return { cursors, domains, eventType: value.eventType };
}

function parseSequenceCursor(value: unknown): SequenceCursor {
  if (!isRecord(value) || !isDomain(value.domain)) {
    throw new Error('Invalid sequence cursor domain');
  }
  if (!isCursorAddress(value.address)) {
    throw new Error('Invalid sequence cursor address');
  }
  return {
    address: normalizeSequenceAddress(value.address),
    afterSequence:
      value.afterSequence === undefined
        ? undefined
        : parseInteger(
            value.afterSequence,
            -1,
            'afterSequence must be an integer string greater than or equal to -1',
          ),
    domain: value.domain,
  };
}

export function parseInteger(
  value: unknown,
  min: number,
  error: string,
): bigint {
  if (
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= min) ||
    (typeof value === 'string' &&
      (min < 0 ? /^(?:-1|\d+)$/ : /^\d+$/).test(value))
  ) {
    return BigInt(value);
  }
  throw new Error(error);
}

export function isEventType(value: unknown): value is EventType {
  return EVENT_TYPES.some((eventType) => eventType === value);
}

export function isSequencedEventType(
  value: unknown,
): value is SequencedEventType {
  return SEQUENCED_EVENT_TYPES.some((eventType) => eventType === value);
}

export function isCursorAddress(value: unknown): value is string {
  return typeof value === 'string' && CURSOR_ADDRESS.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
