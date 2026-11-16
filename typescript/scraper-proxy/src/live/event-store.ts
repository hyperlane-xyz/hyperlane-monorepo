import { config } from '../config.js';
import type { DbService } from '../db/db.service.js';
import { quoteIdentifier as q, tables } from '../scraperdb/tables.js';
import type {
  ConfirmationHead,
  ConfirmationRow,
  Position,
} from './confirmation-stream.js';
import {
  type LiveStartBoundary,
  type EventType,
  displayAddress,
  parseOptionalBlockHash,
  parseDatabaseDomain,
  parseId,
} from './protocol.js';
import { PROVISIONAL_MESSAGE_QUERY } from './provisional-message.js';

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
  sequence?: string;
  table: string;
};
function stream(
  table: string,
  domain: string,
  columns: readonly string[],
  sequence?: string,
): Stream {
  return {
    columns,
    domain,
    sequence,
    table,
  };
}

export const STREAMS: Record<EventType, Stream> = {
  dispatch: stream(
    'confirmed_raw_message_dispatch',
    'origin_domain',
    tables.raw_message_dispatch.columns,
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

/** Database reads for live event and message publication. */
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

  /** Read all event types' confirmed boundary in one primary-database snapshot. */
  async liveStartBoundaries(
    domains?: Set<number>,
  ): Promise<Map<number, LiveStartBoundary>> {
    const rows = await this.db.queryLive<Row>(
      `SELECT h.domain, c.height::text AS height, ${LIVE_START_COLUMNS}
       FROM scraper_head h JOIN scraper_checkpoint c
         ON c.domain=h.domain AND c.height=h.confirmed_height
       WHERE h.healthy AND NOT h.halted
         ${domains ? 'AND h.domain=ANY($1::integer[])' : ''}`,
      domains ? [[...domains].map(storedDomain)] : [],
    );
    const boundaries = new Map<number, LiveStartBoundary>();
    for (const row of rows) {
      const boundary = liveStartBoundary(row);
      if (boundary)
        boundaries.set(
          parseDatabaseDomain(row.domain, 'Invalid live-start domain'),
          boundary,
        );
    }
    return boundaries;
  }

  canonicalMessages(messageIds: string[]): Promise<Row[]> {
    return this.db.queryLive<Row>(
      `SELECT ${CANONICAL_MESSAGE_COLUMNS} FROM "message_view" WHERE "msg_id" = ANY($1::bytea[]) AND "send_occurred_at" IS NOT NULL`,
      [messageIds],
    );
  }

  notifiedEvents(eventType: EventType, ids: string[]): Promise<NotifiedRow[]> {
    const stream = STREAMS[eventType];
    const { projection, joins } = eventQueryParts(eventType);
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
    const { projection, joins } = eventQueryParts(eventType);
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
    confirmations?: number,
  ): Promise<Map<number, ConfirmationHead>> {
    // Custom agent streams take their position and block identity from the same
    // snapshot. Checkpoints can be sparse (e.g. skipped slots): start at the last
    // retained checkpoint at or below the requested confirmation frontier.
    const rows = await this.db.queryLive<Row>(
      confirmations === undefined
        ? 'SELECT domain, head_height, indexed_height, confirmed_height FROM scraper_head WHERE domain=ANY($1::integer[])'
        : `SELECT h.domain, h.head_height, h.indexed_height, h.confirmed_height,
                  c.height::text AS height, ${LIVE_START_COLUMNS}
           FROM scraper_head h LEFT JOIN LATERAL (
             SELECT height, hash FROM scraper_checkpoint
             WHERE domain=h.domain AND height<=LEAST(h.indexed_height,h.head_height-$2::bigint)
             ORDER BY height DESC LIMIT 1
           ) c ON h.healthy AND NOT h.halted
           WHERE h.domain=ANY($1::integer[])`,
      confirmations === undefined
        ? [[...domains].map(storedDomain)]
        : [[...domains].map(storedDomain), confirmations],
    );
    return new Map(
      rows.map((row) => [
        parseDatabaseDomain(row.domain, 'Invalid head domain'),
        {
          head: parseId(row.head_height),
          indexed: parseId(row.indexed_height),
          confirmed: parseId(row.confirmed_height),
          liveStart: liveStartBoundary(row),
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
    // Provisional Merkle writes need block identity for reconnect/reorg checks.
    // Keep the canonical wire projection compatible with existing validators.
    const blockHash =
      eventType === 'merkle_tree_insertion' ? ', event_row.block_hash' : '';
    let position = after;
    while (true) {
      const rows = await this.db.queryLive<Row>(
        `/* confirmation_events */ SELECT ${projection}${blockHash}, event_row.id AS frontier_id, event_row.${q(height)} AS frontier_height
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
      for (const { frontier_id, frontier_height, block_hash, ...row } of rows) {
        position = [parseId(frontier_height), 0, parseId(frontier_id)];
        yield {
          position,
          message: {
            ...eventMessage(eventType, row),
            confirmations,
            height: position[0].toString(),
            blockHash: block_hash,
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
    messageIds?: Set<string>,
  ): AsyncIterable<ConfirmationRow> {
    if (messageIds?.size === 0) return;
    const filter = messageIds ? ' AND msg_id = ANY($7::bytea[])' : '';
    let position = after;
    while (true) {
      const changes = await this.db.queryLive<{
        height: string;
        source: number;
        id: string;
        msg_id: string;
      }>(
        `/* confirmation_messages */ SELECT * FROM (
          SELECT origin_block_height AS height, 0 AS source, id, msg_id FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_block_height>=$2::bigint AND origin_block_height<=$5::bigint${filter}
          UNION ALL SELECT block_number, 1, id, msg_id FROM delivered_message WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint${filter}
          UNION ALL SELECT block_number, 2, id, msg_id FROM gas_payment WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint${filter}
        ) changes WHERE (height, source, id)>($2::bigint,$3::integer,$4::bigint) ORDER BY height, source, id LIMIT $6`,
        [
          storedDomain(domain),
          position[0].toString(),
          position[1],
          position[2].toString(),
          through.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
          ...(messageIds ? [[...messageIds]] : []),
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
}

function columns(stream: Stream): string {
  return stream.columns.map((column) => `"event_row".${q(column)}`).join(', ');
}

function gasPaymentColumns(stream: Stream): string {
  return [
    columns(stream),
    `COALESCE("event_row"."transaction_hash", ${q(GAS_PAYMENT_TRANSACTION)}."hash") AS "origin_tx_hash"`,
    `COALESCE("event_row"."block_hash", ${q(GAS_PAYMENT_BLOCK)}."hash") AS "origin_block_hash"`,
    `COALESCE("event_row"."block_number", ${q(GAS_PAYMENT_BLOCK)}."height") AS "origin_block_height"`,
  ].join(', ');
}

function gasPaymentMetadataJoins(): string {
  return ` LEFT JOIN "transaction" AS ${q(GAS_PAYMENT_TRANSACTION)} ON ${q(GAS_PAYMENT_TRANSACTION)}."id" = "event_row"."tx_id" LEFT JOIN "block" AS ${q(GAS_PAYMENT_BLOCK)} ON ${q(GAS_PAYMENT_BLOCK)}."id" = ${q(GAS_PAYMENT_TRANSACTION)}."block_id"`;
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

function eventData(eventType: EventType, row: Row): Row {
  let data = row;
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

function rowSequence(eventType: EventType, row: Row): bigint | undefined {
  const sequence = STREAMS[eventType].sequence;
  return sequence ? parseId(row[sequence]) : undefined;
}

export function eventMessage(
  eventType: EventType,
  row: Row,
): Record<string, unknown> {
  return {
    type: 'event',
    eventType,
    domain: rowDomain(row, STREAMS[eventType].domain),
    data: eventData(eventType, row),
    sequence: rowSequence(eventType, row)?.toString(),
    rowId: eventType === 'gas_payment' ? parseId(row.id).toString() : undefined,
  };
}

export function compareRows(eventType: EventType, a: Row, b: Row): number {
  const left =
    eventType === 'gas_payment' ? parseId(a.id) : rowSequence(eventType, a);
  const right =
    eventType === 'gas_payment' ? parseId(b.id) : rowSequence(eventType, b);
  return left === undefined || right === undefined || left === right
    ? 0
    : left < right
      ? -1
      : 1;
}

function eventQueryParts(eventType: EventType): {
  projection: string;
  joins: string;
} {
  const stream = STREAMS[eventType];
  return eventType === 'gas_payment'
    ? {
        projection: gasPaymentColumns(stream),
        joins: gasPaymentMetadataJoins(),
      }
    : { projection: columns(stream), joins: '' };
}

const LIVE_START_COLUMNS = `encode(c.hash, 'hex') AS hash,
  encode(h.mailbox, 'hex') AS mailbox,
  encode(h.merkle_tree_hook, 'hex') AS merkle_tree_hook,
  encode(h.interchain_gas_paymaster, 'hex') AS interchain_gas_paymaster`;

function liveStartBoundary(row: Row): LiveStartBoundary | undefined {
  const hash = parseOptionalBlockHash(row.hash);
  if (
    !hash ||
    typeof row.height !== 'string' ||
    !/^\d+$/.test(row.height) ||
    typeof row.mailbox !== 'string' ||
    typeof row.merkle_tree_hook !== 'string' ||
    typeof row.interchain_gas_paymaster !== 'string'
  )
    return undefined;
  const contracts = {
    dispatch: displayAddress(row.mailbox),
    delivery: displayAddress(row.mailbox),
    merkle_tree_insertion: displayAddress(row.merkle_tree_hook),
    gas_payment: displayAddress(row.interchain_gas_paymaster),
  };
  if (
    Object.values(contracts).some(
      (address) => !/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(address),
    )
  )
    return undefined;
  return { height: parseId(row.height).toString(), hash, contracts };
}
