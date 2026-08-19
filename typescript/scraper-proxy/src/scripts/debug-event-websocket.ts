import { parseArgs } from 'node:util';

import { type RawData, WebSocket } from 'ws';

import { EVENT_TYPES, type EventType, isDomain } from '../live/protocol.js';

const DEFAULT_URL = 'ws://localhost:8383/ws';

const HELP = `Usage: pnpm debug:websocket [options]

Connect to the scraper proxy event WebSocket and print every server message.
By default, subscribes to every event type on every domain.

Options:
  -u, --url <url>            WebSocket URL (default: ${DEFAULT_URL})
  -e, --events <events>      Event types, comma-separated or repeated
  -d, --domains <domains>    Domain IDs, comma-separated or repeated
  -c, --cursor <cursor>      Native cursor, repeatable:
                             eventType:domain:address:afterSequence
                             Use -1 for the earliest sequence stored in the DB
  -h, --help                 Show this help

Event types: ${EVENT_TYPES.join(', ')}

Examples:
  pnpm debug:websocket
  pnpm debug:websocket --events dispatch,delivery
  pnpm debug:websocket -e gas_payment -d 1,42161
  pnpm debug:websocket --url ws://localhost:9000/ws --domains 1
  pnpm debug:websocket -e merkle_tree_insertion \\
    --cursor merkle_tree_insertion:1:0x48e6c30b97748d1e2e03bf3e9fbe3890ca5f8cca:-1
`;

type NativeCursor = {
  address: string;
  afterSequence: string;
  domain: number;
  eventType: 'dispatch' | 'merkle_tree_insertion';
};

type Options = {
  cursors: NativeCursor[];
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

function parseCursor(value: string): NativeCursor {
  const [eventType, rawDomain, address, afterSequence, ...extra] =
    value.split(':');
  if (
    extra.length > 0 ||
    !eventType ||
    !rawDomain ||
    !address ||
    afterSequence === undefined
  ) {
    throw new Error(
      `Invalid cursor "${value}". Expected eventType:domain:address:afterSequence`,
    );
  }
  if (eventType !== 'dispatch' && eventType !== 'merkle_tree_insertion') {
    throw new Error(
      `Cursor event type must be dispatch or merkle_tree_insertion: ${eventType}`,
    );
  }

  const domain = Number(rawDomain);
  if (!isDomain(domain)) throw new Error(`Invalid cursor domain: ${rawDomain}`);
  if (!/^(?:0x|\\x)?[0-9a-fA-F]{2,64}$/.test(address)) {
    throw new Error(`Invalid cursor address: ${address}`);
  }
  if (!/^(?:-1|\d+)$/.test(afterSequence)) {
    throw new Error(`Invalid cursor sequence: ${afterSequence}`);
  }

  return { address, afterSequence, domain, eventType };
}

function parseOptions(): Options | undefined {
  const { values } = parseArgs({
    allowPositionals: false,
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

  const eventTypes = (requestedEvents ?? EVENT_TYPES) as EventType[];
  const cursors = (values.cursor ?? []).map(parseCursor);
  for (const cursor of cursors) {
    if (!eventTypes.includes(cursor.eventType)) {
      throw new Error(
        `Cursor event type ${cursor.eventType} is not included in --events`,
      );
    }
    if (domains && !domains.includes(cursor.domain)) {
      throw new Error(
        `Cursor domain ${cursor.domain} is not included in --domains`,
      );
    }
  }

  return {
    cursors,
    domains,
    eventTypes,
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
      streams: options.eventTypes.map((eventType) => {
        const cursors = options.cursors
          .filter((cursor) => cursor.eventType === eventType)
          .map(({ address, afterSequence, domain }) => ({
            address,
            afterSequence,
            domain,
          }));
        return {
          ...(cursors.length > 0 ? { cursors } : {}),
          ...(options.domains ? { domains: options.domains } : {}),
          eventType,
        };
      }),
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
