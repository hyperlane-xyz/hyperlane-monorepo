import { parseArgs } from 'node:util';

import { type RawData, WebSocket } from 'ws';

import { EVENT_TYPES, type EventType, isDomain } from '../live/protocol.js';

const DEFAULT_URL = 'ws://localhost:8383/ws';

const HELP = `Usage: pnpm debug:websocket [options]

Connect to the scraper proxy event WebSocket and print every server message.
By default, subscribes to every event type on every domain.

Options:
  -u, --url <url>          WebSocket URL (default: ${DEFAULT_URL})
  -e, --events <events>    Event types, comma-separated or repeated
  -d, --domains <domains>  Domain IDs, comma-separated or repeated
  -h, --help               Show this help

Event types: ${EVENT_TYPES.join(', ')}

Examples:
  pnpm debug:websocket
  pnpm debug:websocket --events dispatch,delivery
  pnpm debug:websocket -e gas_payment -d 1,42161
  pnpm debug:websocket --url ws://localhost:9000/ws --domains 1
`;

type Options = {
  domains?: number[];
  eventTypes: EventType[];
  url: string;
};

function readList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const items = values
    .flatMap((value) => value.split(','))
    .map((v) => v.trim());
  if (items.some((item) => item.length === 0)) {
    throw new Error('List values cannot be empty');
  }
  return [...new Set(items)];
}

function parseOptions(): Options | undefined {
  const { values } = parseArgs({
    allowPositionals: false,
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

  const requestedEvents = readList(values.events);
  const invalidEvents = requestedEvents?.filter(
    (eventType) => !EVENT_TYPES.includes(eventType as EventType),
  );
  if (invalidEvents?.length) {
    throw new Error(
      `Unknown event type(s): ${invalidEvents.join(', ')}. Expected: ${EVENT_TYPES.join(', ')}`,
    );
  }

  const requestedDomains = readList(values.domains);
  const domains = requestedDomains?.map((domain) => Number(domain));
  const invalidDomains = requestedDomains?.filter(
    (_, index) => !isDomain(domains?.[index]),
  );
  if (invalidDomains?.length) {
    throw new Error(`Invalid domain ID(s): ${invalidDomains.join(', ')}`);
  }

  return {
    domains,
    eventTypes: (requestedEvents ?? EVENT_TYPES) as EventType[],
    url: values.url,
  };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function main(options: Options): void {
  const socket = new WebSocket(options.url);
  let subscribed = false;

  socket.on('message', (data) => {
    const raw = rawDataToString(data);

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      process.stdout.write(`${raw}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    if (
      subscribed ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'ready'
    ) {
      return;
    }

    const subscription = {
      streams: options.eventTypes.map((eventType) => ({
        ...(options.domains ? { domains: options.domains } : {}),
        eventType,
      })),
      type: 'subscribe',
    };
    const payload = JSON.stringify(subscription);
    socket.send(payload);
    subscribed = true;
  });
  socket.on('error', (error) =>
    console.error(`WebSocket error: ${error.message}`),
  );
  process.once('SIGINT', () => socket.close(1000, 'SIGINT'));
  process.once('SIGTERM', () => socket.close(1000, 'SIGTERM'));
}

try {
  const options = parseOptions();
  if (options) main(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error('\nRun with --help for usage.');
  process.exitCode = 1;
}
