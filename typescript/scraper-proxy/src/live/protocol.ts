export const EVENT_TYPES = [
  'dispatch',
  'delivery',
  'gas_payment',
  'merkle_tree_insertion',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

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

export function parseClientMessage(raw: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON message');
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid client message');
  }
  if (value.type === 'ping') return { type: 'ping' };
  if (value.type !== 'subscribe' || !Array.isArray(value.streams)) {
    throw new Error('Unsupported client message type');
  }
  if (value.streams.length === 0 || value.streams.length > EVENT_TYPES.length) {
    throw new Error(`Subscribe to between 1 and ${EVENT_TYPES.length} streams`);
  }

  const streams = value.streams.map(parseStreamRequest);
  if (
    new Set(streams.map(({ eventType }) => eventType)).size !== streams.length
  ) {
    throw new Error('Duplicate eventType subscription');
  }
  return { streams, type: 'subscribe' };
}

export function parseCursor(value: unknown): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d+$/.test(value))
  ) {
    return BigInt(value);
  }
  throw new Error('id must be a non-negative integer string');
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
    id: parseCursor(value.id),
  };
}

export function isDomain(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

function parseStreamRequest(value: unknown): StreamRequest {
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
      value.domains.length === 0 ||
      !value.domains.every(isDomain)
    ) {
      throw new Error('domains must contain valid domain IDs');
    }
    domains = new Set(value.domains);
  }

  let cursors: SequenceCursor[] | undefined;
  if (value.cursors !== undefined) {
    if (
      value.eventType !== 'dispatch' &&
      value.eventType !== 'merkle_tree_insertion'
    ) {
      throw new Error('cursors are only supported for sequenced streams');
    }
    if (!Array.isArray(value.cursors) || value.cursors.length === 0) {
      throw new Error('cursors must be a non-empty array');
    }
    cursors = value.cursors.map(parseSequenceCursor);
    const keys = cursors.map(({ address, domain }) => `${domain}:${address}`);
    if (new Set(keys).size !== keys.length) {
      throw new Error('Duplicate sequence cursor');
    }
    if (domains) {
      const subscribedDomains = domains;
      if (cursors.some(({ domain }) => !subscribedDomains.has(domain))) {
        throw new Error('Cursor domain must be included in domains');
      }
    }
    domains ??= new Set(cursors.map(({ domain }) => domain));
  }

  return {
    cursors,
    domains,
    eventType: value.eventType,
  };
}

function parseSequenceCursor(value: unknown): SequenceCursor {
  if (!isRecord(value) || !isDomain(value.domain)) {
    throw new Error('Invalid sequence cursor domain');
  }
  if (
    typeof value.address !== 'string' ||
    !/^(?:0x|\\x)?[0-9a-fA-F]{2,64}$/.test(value.address)
  ) {
    throw new Error('Invalid sequence cursor address');
  }

  let afterSequence: bigint | undefined;
  if (value.afterSequence !== undefined) {
    if (
      (typeof value.afterSequence === 'number' &&
        Number.isSafeInteger(value.afterSequence) &&
        value.afterSequence >= -1) ||
      (typeof value.afterSequence === 'string' &&
        /^(?:-1|\d+)$/.test(value.afterSequence))
    ) {
      afterSequence = BigInt(value.afterSequence);
    } else {
      throw new Error(
        'afterSequence must be an integer string greater than or equal to -1',
      );
    }
  }

  return {
    address: normalizeAddress(value.address),
    afterSequence,
    domain: value.domain,
  };
}

function normalizeAddress(value: string): string {
  const hex = value.replace(/^(?:0x|\\x)/, '').toLowerCase();
  return `\\x${hex}`;
}

function isEventType(value: unknown): value is EventType {
  return EVENT_TYPES.includes(value as EventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
