import { config } from '../config.js';
import type { DbService } from '../db/db.service.js';
import { quoteIdentifier as q, tables } from '../scraperdb/tables.js';
import type {
  ConfirmationHead,
  ConfirmationRow,
  Position,
} from './confirmation-stream.js';
import {
  type EventType,
  type GasPaymentCursor,
  type SequenceCursor,
  isSequencedEventType,
  normalizeSequenceAddress,
  parseDatabaseDomain,
  parseId,
  parseInteger,
} from './protocol.js';
import { PROVISIONAL_MESSAGE_QUERY } from './provisional-message.js';

const GAS_PAYMENT_STREAM_CURSOR = 'gas_payment_stream_cursor';
const GAS_PAYMENT_STREAM_HEAD = 'gas_payment_stream_head';
const STREAM_CURSOR_COLUMN = 'scraper_stream_cursor';
const GAS_PAYMENT_TRANSACTION = 'event_transaction';
const GAS_PAYMENT_BLOCK = 'event_block';
const FRONTIER_ID = 'frontier_id';
const FRONTIER_HEIGHT = 'frontier_height';
const CANONICAL_MESSAGE_COLUMNS = tables.message_view.columns
  .filter((column) => column !== 'is_provisional')
  .map(q)
  .join(', ');

export type Row = Record<string, unknown>;
type NotifiedRow = Row & { notification_id: number | string };
type Stream = {
  columns: readonly string[];
  domain: string;
  projection: string;
  sequence?: { address: string; value: string };
  table: string;
};
function stream(
  table: string,
  domain: string,
  columns: readonly string[],
  address?: string,
  sequence?: string,
): Stream {
  return {
    columns,
    domain,
    projection: columns.map(q).join(', '),
    sequence: address && sequence ? { address, value: sequence } : undefined,
    table,
  };
}

export const STREAMS: Record<EventType, Stream> = {
  dispatch: stream(
    'confirmed_raw_message_dispatch',
    'origin_domain',
    tables.raw_message_dispatch.columns,
    'origin_mailbox',
    'nonce',
  ),
  delivery: stream(
    'confirmed_delivered_message',
    'domain',
    'time_created msg_id domain destination_mailbox destination_tx_id sequence'.split(
      ' ',
    ),
  ),
  gas_payment: stream(
    'confirmed_gas_payment',
    'domain',
    'id time_created domain msg_id payment gas_amount tx_id log_index origin destination interchain_gas_paymaster sequence'.split(
      ' ',
    ),
  ),
  merkle_tree_insertion: stream(
    'confirmed_merkle_tree_insertion',
    'domain',
    'domain merkle_tree_hook leaf_index message_id block_number'.split(' '),
    'merkle_tree_hook',
    'leaf_index',
  ),
};

const EVENT_DOMAIN_COLUMNS: Record<EventType, readonly string[]> = {
  delivery: ['domain'],
  dispatch: ['origin_domain', 'destination_domain'],
  gas_payment: ['domain', 'origin', 'destination'],
  merkle_tree_insertion: ['domain'],
};

const MAX_PROVISIONAL_MESSAGE_CACHE_ENTRIES = 128;
type ProvisionalMessage = { data: Row; domains: number[] };

/** Database reads shared by live publication and historical replay. */
export class EventStore {
  private readonly cache = new Map<string, Promise<ProvisionalMessage[]>>();

  constructor(private readonly db: Pick<DbService, 'queryLive'>) {}

  blockHeads(domains?: Set<number>) {
    return this.db.queryLive<{
      domain: number;
      indexed_height: string;
      hash: string;
      head_height: string;
    }>(
      `SELECT domain, indexed_height, encode(indexed_hash, 'hex') AS hash, head_height
       FROM scraper_head${domains ? ' WHERE domain=ANY($1::integer[])' : ''}`,
      domains ? [[...domains].map(storedDomain)] : [],
    );
  }

  canonicalMessages(messageIds: string[]): Promise<Row[]> {
    return this.db.queryLive<Row>(
      `SELECT ${CANONICAL_MESSAGE_COLUMNS} FROM "message_view" WHERE "msg_id" = ANY($1::bytea[]) AND "send_occurred_at" IS NOT NULL`,
      [messageIds],
    );
  }

  notifiedEvents(eventType: EventType, ids: string[]): Promise<NotifiedRow[]> {
    const stream = STREAMS[eventType];
    const { projection, joins } = eventQueryParts(eventType, 'legacy');
    return this.db.queryLive<NotifiedRow>(
      `SELECT "event_row"."id" AS "notification_id", ${projection} FROM ${q(stream.table)} AS "event_row"${joins} WHERE "event_row"."id" = ANY($1::bigint[]) ORDER BY "event_row"."id" ASC`,
      [ids],
    );
  }

  async *headEvents(
    eventType: EventType,
    domain: number,
    after: bigint,
    through: bigint,
  ): AsyncIterable<Row[]> {
    const stream = STREAMS[eventType];
    const height =
      eventType === 'dispatch' ? 'origin_block_height' : 'block_number';
    const { projection, joins } = eventQueryParts(eventType, 'mapped');
    let cursorHeight = after;
    let cursorId = 0n;
    while (true) {
      const rows = await this.db.queryLive<Row>(
        `SELECT ${projection}, "event_row"."id" AS ${q(FRONTIER_ID)}, "event_row".${q(height)} AS ${q(FRONTIER_HEIGHT)} FROM (SELECT * FROM ${q(stream.table)} AS "frontier_row" WHERE "frontier_row".${q(stream.domain)}=$1 AND "frontier_row".${q(height)}>$2::bigint AND "frontier_row".${q(height)}<=$3::bigint AND ("frontier_row".${q(height)}>$4::bigint OR ("frontier_row".${q(height)}=$4::bigint AND "frontier_row"."id">$5::bigint)) ORDER BY "frontier_row".${q(height)}, "frontier_row"."id" LIMIT $6) AS "event_row"${joins} ORDER BY "event_row".${q(height)}, "event_row"."id"`,
        [
          storedDomain(domain),
          after.toString(),
          through.toString(),
          cursorHeight.toString(),
          cursorId.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
        ],
      );
      const lastByHeight = rows.at(-1);
      if (!lastByHeight) return;
      const nextHeight = parseId(lastByHeight[FRONTIER_HEIGHT]);
      const nextId = parseId(lastByHeight[FRONTIER_ID]);
      const events = rows.map(
        ({ [FRONTIER_ID]: _id, [FRONTIER_HEIGHT]: _height, ...event }) => event,
      );
      events.sort((a, b) => compareRows(eventType, a, b));
      yield events;
      cursorHeight = nextHeight;
      cursorId = nextId;
      if (rows.length < config.EVENT_STREAM_BATCH_SIZE) return;
    }
  }

  async confirmationHeads(
    domains: Set<number>,
  ): Promise<Map<number, ConfirmationHead>> {
    const rows = await this.db.queryLive<{
      domain: number;
      head_height: string;
      indexed_height: string;
      confirmed_height: string;
    }>(
      'SELECT domain, head_height, indexed_height, confirmed_height FROM scraper_head WHERE domain=ANY($1::integer[])',
      [[...domains].map(storedDomain)],
    );
    return new Map(
      rows.map((row) => [
        parseDatabaseDomain(row.domain, 'Invalid head domain'),
        {
          head: parseId(row.head_height),
          indexed: parseId(row.indexed_height),
          confirmed: parseId(row.confirmed_height),
        },
      ]),
    );
  }

  invalidateMessages(): void {
    this.cache.clear();
  }

  async *confirmationEventRows(
    eventType: EventType,
    domain: number,
    after: Position,
    through: bigint,
    confirmations: number,
  ): AsyncIterable<ConfirmationRow> {
    const stream = STREAMS[eventType];
    const table = stream.table.replace('confirmed_', '');
    const height =
      eventType === 'dispatch' ? 'origin_block_height' : 'block_number';
    const { projection, joins } = eventQueryParts(eventType);
    let position = after;
    while (true) {
      const rows = await this.db.queryLive<Row>(
        `/* confirmation_events */ SELECT ${projection}, event_row.id AS frontier_id, event_row.${q(height)} AS frontier_height
         FROM (SELECT * FROM ${q(table)} WHERE ${q(stream.domain)}=$1
           AND (${q(height)}, id)>($2::bigint,$3::bigint) AND ${q(height)}<=$4::bigint
           ORDER BY ${q(height)}, id LIMIT $5) event_row${joins}
         ORDER BY event_row.${q(height)}, event_row.id`,
        [
          storedDomain(domain),
          position[0].toString(),
          position[2].toString(),
          through.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
        ],
      );
      for (const { frontier_id, frontier_height, ...row } of rows) {
        position = [parseId(frontier_height), 0, parseId(frontier_id)];
        yield {
          position,
          message: {
            type: 'event',
            eventType,
            domain,
            confirmations,
            height: position[0].toString(),
            data: eventData(eventType, row),
            sequence: rowSequence(eventType, row)?.value.toString(),
            rowId:
              eventType === 'gas_payment'
                ? parseId(row.id).toString()
                : undefined,
          },
        };
      }
      if (rows.length < config.EVENT_STREAM_BATCH_SIZE) return;
    }
  }

  async *confirmationMessageRows(
    domain: number,
    after: Position,
    through: bigint,
    frontiers: Map<number, bigint>,
    confirmations: number,
  ): AsyncIterable<ConfirmationRow> {
    let position = after;
    while (true) {
      const changes = await this.db.queryLive<{
        height: string;
        source: number;
        id: string;
        msg_id: string;
      }>(
        `/* confirmation_messages */ SELECT * FROM (
          SELECT origin_block_height AS height, 0 AS source, id, msg_id FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_block_height>=$2::bigint AND origin_block_height<=$5::bigint
          UNION ALL SELECT block_number, 1, id, msg_id FROM delivered_message WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint
          UNION ALL SELECT block_number, 2, id, msg_id FROM gas_payment WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint
        ) changes WHERE (height, source, id)>($2::bigint,$3::integer,$4::bigint) ORDER BY height, source, id LIMIT $6`,
        [
          storedDomain(domain),
          position[0].toString(),
          position[1],
          position[2].toString(),
          through.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
        ],
      );
      if (!changes.length) return;
      const rows = await this.provisionalMessages(
        [...new Set(changes.map((row) => row.msg_id))],
        frontiers,
      );
      const messages = new Map(rows.map((row) => [row.data.msg_id, row]));
      for (const change of changes) {
        position = [parseId(change.height), change.source, parseId(change.id)];
        const row = messages.get(change.msg_id);
        yield {
          domains: row?.domains,
          position,
          message: row && {
            type: 'message_upsert',
            domain,
            confirmations,
            height: through.toString(),
            data: row.data,
          },
        };
      }
      if (changes.length < config.EVENT_STREAM_BATCH_SIZE) return;
    }
  }

  async provisionalMessages(
    ids: string[],
    frontiers: Map<number, bigint>,
  ): Promise<ProvisionalMessage[]> {
    const sortedIds = [...new Set(ids)].sort();
    const sortedFrontiers = [...frontiers].sort(([a], [b]) => a - b);
    const key = JSON.stringify([
      sortedIds,
      sortedFrontiers.map(([domain, height]) => [domain, String(height)]),
    ]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    // Entries survive only until the next head/message change, with a hard bound.
    if (this.cache.size >= MAX_PROVISIONAL_MESSAGE_CACHE_ENTRIES)
      this.cache.clear();
    const result = this.db
      .queryLive<Row>(PROVISIONAL_MESSAGE_QUERY, [
        sortedIds,
        sortedFrontiers.map(([domain]) => storedDomain(domain)),
        sortedFrontiers.map(([, height]) => String(height)),
      ])
      .then((rows) =>
        rows.map((row) => {
          const { payment_domain_ids: _, ...data } = row;
          const origin = rowDomain(row, 'origin_domain_id');
          const destination = rowDomain(row, 'destination_domain_id');
          return {
            data: {
              ...data,
              origin_domain_id: origin,
              destination_domain_id: destination,
            },
            domains: [
              origin,
              destination,
              ...rowDomains(row, 'payment_domain_ids'),
            ],
          };
        }),
      )
      .catch((error: unknown) => {
        if (this.cache.get(key) === result) this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, result);
    return result;
  }

  sequenceRows(
    eventType: EventType,
    cursor: SequenceCursor,
    after: bigint,
    through: bigint,
  ): Promise<Row[]> {
    const stream = STREAMS[eventType];
    const sequence = sequenceConfig(stream);
    return this.db.queryLive<Row>(
      `SELECT ${columns(stream)} FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea AND ${q(sequence.value)} > $3::bigint AND ${q(sequence.value)} <= $4::bigint ORDER BY ${q(sequence.value)} ASC LIMIT $5`,
      replayValues(cursor, after, through),
    );
  }

  async sequenceBounds(
    eventType: EventType,
    cursor: SequenceCursor,
  ): Promise<{ first: bigint; last: bigint }> {
    const stream = STREAMS[eventType];
    const sequence = sequenceConfig(stream);
    const [row] = await this.db.queryLive<{ first: string; last: string }>(
      `SELECT COALESCE(MIN(${q(sequence.value)}), 0)::text AS first, COALESCE(MAX(${q(sequence.value)}), -1)::text AS last FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea`,
      [storedDomain(cursor.domain), cursor.address],
    );
    return {
      first: parseSequence(row?.first ?? '0'),
      last: parseSequence(row?.last ?? '-1'),
    };
  }

  gasPaymentRows(
    cursor: GasPaymentCursor,
    after: bigint,
    through: bigint,
    legacy: boolean,
  ): Promise<Row[]> {
    const stream = STREAMS.gas_payment;
    const source = legacy
      ? `(SELECT * FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND "interchain_gas_paymaster" = $2::bytea AND "id" > $3::bigint AND "id" <= $4::bigint ORDER BY "id" ASC LIMIT $5) AS "event_row"`
      : `(SELECT "gas_payment_id", "stream_cursor" FROM ${q(GAS_PAYMENT_STREAM_CURSOR)} WHERE "domain" = $1 AND "interchain_gas_paymaster" = $2::bytea AND "stream_cursor" > $3::bigint AND "stream_cursor" <= $4::bigint ORDER BY "stream_cursor" ASC LIMIT $5) AS "event_cursor" INNER JOIN ${q(stream.table)} AS "event_row" ON "event_row"."id" = "event_cursor"."gas_payment_id"`;
    const position = legacy
      ? `"event_row"."id"`
      : `"event_cursor"."stream_cursor"`;
    // Limit the replay page before optional receipt enrichment in either phase.
    return this.db.queryLive<Row>(
      `SELECT ${gasPaymentColumns(stream)}, ${position} AS ${q(STREAM_CURSOR_COLUMN)} FROM ${source}${gasPaymentMetadataJoins()} ORDER BY ${position} ASC`,
      replayValues(cursor, after, through),
    );
  }

  async gasPaymentCursorBounds(
    cursor: GasPaymentCursor,
  ): Promise<{ lastCursor: bigint; legacyMaxId: bigint }> {
    const [row] = await this.db.queryLive<{
      last_cursor: string;
      legacy_max_id: string;
    }>(
      `SELECT COALESCE("legacy_max_id", 0)::text AS legacy_max_id, COALESCE("last_cursor", 0)::text AS last_cursor FROM ${q(GAS_PAYMENT_STREAM_HEAD)} WHERE "domain" = $1 AND "interchain_gas_paymaster" = $2::bytea`,
      [storedDomain(cursor.domain), cursor.address],
    );
    return {
      lastCursor: parseId(row?.last_cursor ?? '0'),
      legacyMaxId: parseId(row?.legacy_max_id ?? '0'),
    };
  }
}

function replayValues(
  cursor: GasPaymentCursor | SequenceCursor,
  after: bigint,
  through: bigint,
): unknown[] {
  return [
    storedDomain(cursor.domain),
    cursor.address,
    String(after),
    String(through),
    config.EVENT_STREAM_BATCH_SIZE,
  ];
}

function columns(stream: Stream, relation?: string): string {
  return relation
    ? stream.columns.map((column) => `${q(relation)}.${q(column)}`).join(', ')
    : stream.projection;
}

export function gasPaymentColumns(stream: Stream): string {
  return [
    columns(stream, 'event_row'),
    `COALESCE("event_row"."transaction_hash", ${q(GAS_PAYMENT_TRANSACTION)}."hash") AS "origin_tx_hash"`,
    `COALESCE("event_row"."block_hash", ${q(GAS_PAYMENT_BLOCK)}."hash") AS "origin_block_hash"`,
    `COALESCE("event_row"."block_number", ${q(GAS_PAYMENT_BLOCK)}."height") AS "origin_block_height"`,
  ].join(', ');
}

export function gasPaymentMetadataJoins(): string {
  return ` LEFT JOIN "transaction" AS ${q(GAS_PAYMENT_TRANSACTION)} ON ${q(GAS_PAYMENT_TRANSACTION)}."id" = "event_row"."tx_id" LEFT JOIN "block" AS ${q(GAS_PAYMENT_BLOCK)} ON ${q(GAS_PAYMENT_BLOCK)}."id" = ${q(GAS_PAYMENT_TRANSACTION)}."block_id"`;
}

function gasPaymentCursorExpression(): string {
  return `COALESCE("event_cursor"."stream_cursor", "event_row"."id")`;
}

function sequenceConfig(stream: Stream): NonNullable<Stream['sequence']> {
  if (!stream.sequence) throw new Error('Stream has no native sequence');
  return stream.sequence;
}

export function rowDomain(row: Row, column: string): number {
  return parseDatabaseDomain(row[column], `Invalid ${column} in event row`);
}

function rowDomains(row: Row, column: string): number[] {
  const values = row[column];
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`Invalid ${column} in event row`);
  return values.map((value) =>
    parseDatabaseDomain(value, `Invalid ${column} in event row`),
  );
}

export function eventData(eventType: EventType, row: Row): Row {
  let data = eventType === 'gas_payment' ? withoutStreamCursor(row) : row;
  for (const column of EVENT_DOMAIN_COLUMNS[eventType]) {
    const domain = parseDatabaseDomain(
      data[column],
      `Invalid ${column} in event row`,
    );
    if (data[column] !== domain) data = { ...data, [column]: domain };
  }
  return data;
}

function storedDomain(domain: number): number {
  return domain > 0x7fff_ffff ? domain - 0x1_0000_0000 : domain;
}

function rowSequence(
  eventType: EventType,
  row: Row,
): { address: string; value: bigint } | undefined {
  if (!isSequencedEventType(eventType)) return undefined;
  const sequence = sequenceConfig(STREAMS[eventType]);
  const address = row[sequence.address];
  if (typeof address !== 'string') {
    throw new Error(`Invalid ${sequence.address} in event row`);
  }
  return {
    address: normalizeSequenceAddress(address),
    value: parseSequence(row[sequence.value]),
  };
}

function parseSequence(value: unknown): bigint {
  return parseInteger(value, -1, 'Invalid event sequence');
}

export function sequenceKey(domain: number, address: string): string {
  return `${domain}:${normalizeSequenceAddress(address)}`;
}

export function rowCursorKey(
  eventType: EventType,
  domain: number,
  row: Row,
): string | undefined {
  const cursor = rowCursor(eventType, row);
  return cursor && sequenceKey(domain, cursor.address);
}

function gasPaymentStreamCursor(row: Row): { address: string; value: bigint } {
  const address = row.interchain_gas_paymaster;
  if (typeof address !== 'string') {
    throw new Error('Invalid interchain_gas_paymaster in event row');
  }
  return {
    address: normalizeSequenceAddress(address),
    value: parseId(row[STREAM_CURSOR_COLUMN]),
  };
}

function withoutStreamCursor(row: Row): Row {
  const { [STREAM_CURSOR_COLUMN]: _streamCursor, ...data } = row;
  return data;
}

export function compareRows(eventType: EventType, a: Row, b: Row): number {
  const left = rowCursor(eventType, a)?.value;
  const right = rowCursor(eventType, b)?.value;
  return left === undefined || right === undefined || left === right
    ? 0
    : left < right
      ? -1
      : 1;
}

export function rowCursor(
  eventType: EventType,
  row: Row,
): { address: string; value: bigint } | undefined {
  return eventType === 'gas_payment'
    ? gasPaymentStreamCursor(row)
    : rowSequence(eventType, row);
}

function eventQueryParts(
  eventType: EventType,
  cursor?: 'mapped' | 'legacy',
): { projection: string; joins: string } {
  const stream = STREAMS[eventType];
  if (eventType !== 'gas_payment')
    return { projection: columns(stream, 'event_row'), joins: '' };
  const position =
    cursor === 'legacy'
      ? gasPaymentCursorExpression()
      : '"event_cursor"."stream_cursor"';
  return {
    projection:
      gasPaymentColumns(stream) +
      (cursor ? `, ${position} AS ${q(STREAM_CURSOR_COLUMN)}` : ''),
    joins:
      gasPaymentMetadataJoins() +
      (cursor
        ? ` LEFT JOIN ${q(GAS_PAYMENT_STREAM_CURSOR)} AS "event_cursor" ON "event_cursor"."gas_payment_id" = "event_row"."id"`
        : ''),
  };
}
