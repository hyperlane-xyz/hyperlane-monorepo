export const EVENT_TYPES = [
  'dispatch',
  'delivery',
  'gas_payment',
  'merkle_tree_insertion',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type StreamRequest = {
  afterId?: bigint;
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
  throw new Error('afterId must be a non-negative integer string');
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

  return {
    afterId:
      value.afterId === undefined ? undefined : parseCursor(value.afterId),
    domains,
    eventType: value.eventType,
  };
}

function isEventType(value: unknown): value is EventType {
  return EVENT_TYPES.includes(value as EventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
