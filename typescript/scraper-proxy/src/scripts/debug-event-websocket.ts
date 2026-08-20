import { parseArgs } from 'node:util';

import { WebSocket } from 'ws';

import {
  EVENT_TYPES,
  type EventType,
  type SequencedEventType,
  isCursorAddress,
  isDomain,
  isEventType,
  isSequencedEventType,
  parseInteger,
} from '../live/protocol.js';
import { rawData } from '../live/websocket-data.js';

const DEFAULT_URL = 'ws://localhost:8383/agents';
const HELP = `Usage: pnpm debug:websocket [options]

Connect to the scraper proxy event WebSocket and print every server message.
By default, subscribes to every event type on every domain.
The /messages endpoint streams automatically without a subscription.

Options:
  -u, --url <url>            WebSocket URL (default: ${DEFAULT_URL})
  -e, --events <events>      Event types, comma-separated or repeated
  -d, --domains <domains>    Domain IDs, comma-separated or repeated
  -c, --cursor <cursor>      Native cursor, repeatable:
                             eventType:domain:address:afterSequence
                             Use -1 to request from sequence 0
  -h, --help                 Show this help

Event types: ${EVENT_TYPES.join(', ')}

Examples:
  pnpm debug:websocket
  pnpm debug:websocket --events dispatch,delivery
  pnpm debug:websocket -e gas_payment -d 1,42161
  pnpm debug:websocket --url ws://localhost:9000/agents --domains 1
  pnpm debug:websocket --url ws://localhost:8383/messages
  pnpm debug:websocket -e merkle_tree_insertion \\
    --cursor merkle_tree_insertion:1:0x48e6c30b97748d1e2e03bf3e9fbe3890ca5f8cca:-1
`;

type Cursor = {
  address: string;
  afterSequence: string;
  domain: number;
  eventType: SequencedEventType;
};
type Options = {
  cursors: Cursor[];
  domains?: number[];
  events: EventType[];
  url: string;
};

function list(values?: string[]): string[] | undefined {
  if (!values) return undefined;
  const items = [
    ...new Set(
      values.flatMap((value) => value.split(',')).map((v) => v.trim()),
    ),
  ];
  if (items.some((item) => !item))
    throw new Error('List values cannot be empty');
  return items;
}

function cursor(value: string): Cursor {
  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new Error(
      `Invalid cursor "${value}". Expected eventType:domain:address:afterSequence`,
    );
  }
  const [eventType, rawDomain, address, afterSequence] = parts;
  if (!isSequencedEventType(eventType)) {
    throw new Error(
      `Cursor event type must be dispatch or merkle_tree_insertion: ${eventType}`,
    );
  }
  const domain = Number(rawDomain);
  if (!isDomain(domain)) throw new Error(`Invalid cursor domain: ${rawDomain}`);
  if (!isCursorAddress(address)) {
    throw new Error(`Invalid cursor address: ${String(address)}`);
  }
  try {
    parseInteger(afterSequence, -1, 'Invalid cursor sequence');
  } catch {
    throw new Error(`Invalid cursor sequence: ${String(afterSequence)}`);
  }
  return { address, afterSequence, domain, eventType };
}

function options(): Options | undefined {
  const { values } = parseArgs({
    options: {
      cursor: { multiple: true, short: 'c', type: 'string' },
      domains: { multiple: true, short: 'd', type: 'string' },
      events: { multiple: true, short: 'e', type: 'string' },
      help: { short: 'h', type: 'boolean' },
      url: { default: DEFAULT_URL, short: 'u', type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return undefined;
  }

  const requestedEvents = list(values.events);
  const invalidEvents = requestedEvents?.filter((event) => !isEventType(event));
  if (invalidEvents?.length) {
    throw new Error(
      `Unknown event type(s): ${invalidEvents.join(', ')}. Expected: ${EVENT_TYPES.join(', ')}`,
    );
  }
  const events: EventType[] = requestedEvents
    ? requestedEvents.filter(isEventType)
    : [...EVENT_TYPES];
  const rawDomains = list(values.domains);
  const domains = rawDomains?.map(Number);
  const invalidDomains = rawDomains?.filter(
    (_, index) => !isDomain(domains?.[index]),
  );
  if (invalidDomains?.length) {
    throw new Error(`Invalid domain ID(s): ${invalidDomains.join(', ')}`);
  }
  const cursors = (values.cursor ?? []).map(cursor);
  for (const item of cursors) {
    if (!events.includes(item.eventType)) {
      throw new Error(
        `Cursor event type ${item.eventType} is not included in --events`,
      );
    }
  }
  for (const eventType of events) {
    const cursorDomains = new Set(
      cursors
        .filter((item) => item.eventType === eventType)
        .map((item) => item.domain),
    );
    if (
      domains &&
      cursorDomains.size &&
      (domains.length !== cursorDomains.size ||
        domains.some((domain) => !cursorDomains.has(domain)))
    ) {
      throw new Error(
        `--domains must exactly match cursor domains for ${eventType}`,
      );
    }
  }
  return { cursors, domains, events, url: values.url };
}

function run({ cursors, domains, events, url }: Options): void {
  const socket = new WebSocket(url);
  let subscribed = new URL(url).pathname === '/messages';
  socket.on('message', (data) => {
    const raw = rawData(data);
    let message: unknown;
    try {
      message = JSON.parse(raw);
      process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    } catch {
      process.stdout.write(`${raw}\n`);
      return;
    }
    if (subscribed || !isReady(message)) return;
    socket.send(
      JSON.stringify({
        streams: events.map((eventType) => {
          const positions = cursors
            .filter((item) => item.eventType === eventType)
            .map(({ address, afterSequence, domain }) => ({
              address,
              afterSequence,
              domain,
            }));
          return {
            ...(positions.length ? { cursors: positions } : {}),
            ...(domains ? { domains } : {}),
            eventType,
          };
        }),
        type: 'subscribe',
      }),
    );
    subscribed = true;
  });
  socket.on('error', (error) => {
    console.error(`WebSocket error: ${error.message}`);
    process.exitCode = 1;
  });
  socket.on('close', (code, reason) =>
    console.error(`WebSocket closed: ${code} ${reason.toString('utf8')}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => socket.close(1000, signal));
  }
}

function isReady(value: unknown): value is { type: 'ready' } {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'ready'
  );
}

try {
  const parsed = options();
  if (parsed) run(parsed);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error('\nRun with --help for usage.');
  process.exitCode = 1;
}
