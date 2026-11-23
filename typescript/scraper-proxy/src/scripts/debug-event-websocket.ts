import { parseArgs } from 'node:util';

import { formatError } from '@hyperlane-xyz/utils/errors';
import { WebSocket } from 'ws';

import {
  EVENT_TYPES,
  type EventType,
  isDomain,
  isEventType,
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
  -h, --help                 Show this help

Event types: ${EVENT_TYPES.join(', ')}

Examples:
  pnpm debug:websocket
  pnpm debug:websocket --events dispatch,delivery
  pnpm debug:websocket -e gas_payment -d 1,42161
  pnpm debug:websocket --url ws://localhost:9000/agents --domains 1
  pnpm debug:websocket --url ws://localhost:8383/messages
`;

type Options = {
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

function options(): Options | undefined {
  const { values } = parseArgs({
    options: {
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
  return { domains, events, url: values.url };
}

function run({ domains, events, url }: Options): void {
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
        streams: events.map((eventType) => ({ eventType, domains })),
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

function isReady(value: unknown): value is Record<string, unknown> & {
  type: 'ready';
} {
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
  console.error(formatError(error));
  console.error('\nRun with --help for usage.');
  process.exitCode = 1;
}
