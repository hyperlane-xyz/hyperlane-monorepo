import type { Server } from 'node:http';

import { Logger } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { config } from '../config.js';
import { DbService } from '../db/db.service.js';
import { quoteIdentifier as q } from '../scraperdb/tables.js';
import {
  displayAddress,
  EVENT_TYPES,
  type EventNotification,
  type EventType,
  isDomain,
  normalizeAddress,
  parseClientMessage,
  parseEventNotification,
  parseId,
  type SequenceCursor,
  type StreamRequest,
} from './protocol.js';

const WS_PATH = '/ws';
const EVENT_CHANNEL = 'scraper_event';
const HEARTBEAT_MS = 30_000;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;
const MAX_CLIENTS = 500;
const MAX_CLIENT_MESSAGES = 30;
const MAX_PENDING_EVENTS = 5_000;
const MAX_BUFFERED_BYTES = 1_048_576;

type Row = Record<string, unknown>;
type NotifiedRow = Row & { notification_id: number | string };
type Stream = {
  columns: readonly string[];
  domain: string;
  sequence?: { address: string; value: string };
  table: string;
};
type Subscription = {
  catchingUp: boolean;
  domains?: Set<number>;
  pending: Row[];
  sequences: Map<string, bigint>;
};
type Client = {
  alive: boolean;
  messages: number;
  messageWindow: number;
  subscriptions: Map<EventType, Subscription>;
};

function stream(
  table: string,
  domain: string,
  columns: string,
  address?: string,
  sequence?: string,
): Stream {
  return {
    columns: columns.split(' '),
    domain,
    sequence: address && sequence ? { address, value: sequence } : undefined,
    table,
  };
}

const STREAMS: Record<EventType, Stream> = {
  dispatch: stream(
    'raw_message_dispatch',
    'origin_domain',
    'time_created msg_id origin_tx_hash origin_block_hash origin_block_height nonce origin_domain destination_domain sender recipient origin_mailbox msg_body',
    'origin_mailbox',
    'nonce',
  ),
  delivery: stream(
    'delivered_message',
    'domain',
    'time_created msg_id domain destination_mailbox destination_tx_id sequence',
  ),
  gas_payment: stream(
    'gas_payment',
    'domain',
    'time_created domain msg_id payment gas_amount tx_id log_index origin destination interchain_gas_paymaster sequence',
  ),
  merkle_tree_insertion: stream(
    'merkle_tree_insertion',
    'domain',
    'domain merkle_tree_hook leaf_index message_id block_number',
    'merkle_tree_hook',
    'leaf_index',
  ),
};

export class EventWebSocketServer {
  private readonly logger = new Logger(EventWebSocketServer.name);
  private readonly clients = new Map<WebSocket, Client>();
  private readonly notifications = new Map<string, EventNotification>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerRetryTimer?: NodeJS.Timeout;
  private notificationTimer?: NodeJS.Timeout;
  private draining = false;
  private listenerReady = false;
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private server?: WebSocketServer;

  constructor(private readonly db: DbService) {}

  async start(server: Server): Promise<void> {
    await this.connectListener();
    this.server = new WebSocketServer({
      maxPayload: 4_096,
      path: WS_PATH,
      server,
    });
    this.server.on('connection', (socket) => this.connect(socket));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.logger.log(
      `event websocket listening on ${WS_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    [
      this.heartbeatTimer,
      this.listenerRetryTimer,
      this.notificationTimer,
    ].forEach((timer) => timer && clearTimeout(timer));
    this.notifications.clear();
    await this.stopListening?.();
    this.closeClients('Server stopping', 1001);
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
  }

  private connect(socket: WebSocket): void {
    if (!this.listenerReady || this.clients.size >= MAX_CLIENTS) {
      socket.close(
        1013,
        this.listenerReady
          ? 'Maximum websocket clients reached'
          : 'Database event listener unavailable',
      );
      return;
    }
    this.clients.set(socket, {
      alive: true,
      messages: 0,
      messageWindow: Date.now(),
      subscriptions: new Map(),
    });
    this.send(socket, { eventTypes: EVENT_TYPES, type: 'ready' });
    socket.on('pong', () => {
      const client = this.clients.get(socket);
      if (client) client.alive = true;
    });
    socket.on('message', (data) => void this.onMessage(socket, rawData(data)));
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      this.clients.delete(socket);
    });
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const client = this.clients.get(socket);
    if (!client) return;
    if (!consumeMessage(client)) {
      this.sendError(socket, 'Client message rate limit exceeded');
      socket.close(1008, 'Client message rate limit exceeded');
      return;
    }

    let message;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      this.sendError(socket, errorMessage(error));
      return;
    }
    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    if (client.subscriptions.size) {
      this.sendError(socket, 'Already subscribed');
      return;
    }

    for (const request of message.streams) {
      client.subscriptions.set(request.eventType, {
        catchingUp: !!request.cursors,
        domains: request.domains,
        pending: [],
        sequences: new Map(),
      });
    }
    this.send(socket, {
      streams: message.streams.map(subscriptionResponse),
      type: 'subscribed',
    });
    await Promise.all(
      message.streams
        .filter(({ cursors }) => cursors)
        .map((request) => this.catchUp(socket, client, request)),
    );
  }

  private async catchUp(
    socket: WebSocket,
    client: Client,
    request: StreamRequest,
  ): Promise<void> {
    const subscription = client.subscriptions.get(request.eventType);
    if (!subscription) return;
    try {
      for (const cursor of request.cursors ?? []) {
        await this.catchUpCursor(
          socket,
          client,
          request.eventType,
          subscription,
          cursor,
        );
      }
      const pending = subscription.pending.sort((a, b) =>
        compareRows(request.eventType, a, b),
      );
      subscription.pending = [];
      for (const row of pending) {
        if (!this.deliver(socket, request.eventType, subscription, row)) return;
      }
      subscription.catchingUp = false;
    } catch (error) {
      client.subscriptions.delete(request.eventType);
      const reason = errorMessage(error);
      this.logger.warn(
        `websocket catch-up failed eventType=${request.eventType}: ${reason}`,
      );
      this.sendError(
        socket,
        `Failed to catch up ${request.eventType}: ${reason}`,
      );
    }
  }

  private async catchUpCursor(
    socket: WebSocket,
    client: Client,
    eventType: EventType,
    subscription: Subscription,
    cursor: SequenceCursor,
  ): Promise<void> {
    const key = sequenceKey(cursor.domain, cursor.address);
    const { first, last } = await this.sequenceBounds(eventType, cursor);
    const after =
      cursor.afterSequence === -1n
        ? first - 1n
        : (cursor.afterSequence ?? last);
    if (after > last) {
      throw new Error(
        `Sequence ${after} is ahead of current ${eventType} sequence ${last}`,
      );
    }
    subscription.sequences.set(key, after);

    while ((subscription.sequences.get(key) ?? -1n) < last) {
      if (
        this.clients.get(socket) !== client ||
        client.subscriptions.get(eventType) !== subscription
      ) {
        return;
      }
      const current = subscription.sequences.get(key) ?? -1n;
      const rows = await this.sequenceRows(eventType, cursor, current, last);
      if (!rows.length)
        throw new Error(`Missing ${eventType} sequence ${current + 1n}`);
      for (const row of rows) {
        if (!this.deliver(socket, eventType, subscription, row)) {
          throw new Error(`Gap in ${eventType} sequence after ${current}`);
        }
      }
    }
    this.send(socket, {
      address: displayAddress(cursor.address),
      domain: cursor.domain,
      eventType,
      sequence: last.toString(),
      type: 'caught_up',
    });
  }

  private publish(eventType: EventType, row: Row): void {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    for (const [socket, client] of this.clients) {
      const subscription = client.subscriptions.get(eventType);
      if (!subscription || !matches(subscription, domain)) continue;
      if (!subscription.catchingUp) {
        this.deliver(socket, eventType, subscription, row);
      } else if (subscription.pending.push(row) > MAX_PENDING_EVENTS) {
        socket.close(1013, 'Event catch-up buffer exceeded');
      }
    }
  }

  private deliver(
    socket: WebSocket,
    eventType: EventType,
    subscription: Subscription,
    row: Row,
  ): boolean {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    if (!matches(subscription, domain)) return true;
    const sequence = rowSequence(eventType, row);
    if (sequence) {
      const key = sequenceKey(domain, sequence.address);
      const current = subscription.sequences.get(key);
      if (current !== undefined) {
        if (sequence.value <= current) return true;
        if (sequence.value !== current + 1n) {
          socket.close(
            1013,
            `${eventType} sequence gap: expected ${current + 1n}, received ${sequence.value}`,
          );
          return false;
        }
        subscription.sequences.set(key, sequence.value);
      }
    }
    this.send(socket, {
      data: row,
      domain,
      eventType,
      sequence: sequence?.value.toString(),
      type: 'event',
    });
    return true;
  }

  private sequenceRows(
    eventType: EventType,
    cursor: SequenceCursor,
    after: bigint,
    through: bigint,
  ): Promise<Row[]> {
    const stream = STREAMS[eventType];
    const sequence = sequenceConfig(stream);
    return this.db.queryLive<Row>(
      `SELECT ${columns(stream)} FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea AND ${q(sequence.value)} > $3::bigint AND ${q(sequence.value)} <= $4::bigint ORDER BY ${q(sequence.value)} ASC LIMIT $5`,
      [
        cursor.domain,
        cursor.address,
        after.toString(),
        through.toString(),
        config.EVENT_STREAM_BATCH_SIZE,
      ],
    );
  }

  private async sequenceBounds(
    eventType: EventType,
    cursor: SequenceCursor,
  ): Promise<{ first: bigint; last: bigint }> {
    const stream = STREAMS[eventType];
    const sequence = sequenceConfig(stream);
    const [row] = await this.db.queryLive<{ first: string; last: string }>(
      `SELECT COALESCE(MIN(${q(sequence.value)}), 0)::text AS first, COALESCE(MAX(${q(sequence.value)}), -1)::text AS last FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea`,
      [cursor.domain, cursor.address],
    );
    return {
      first: parseSequence(row?.first ?? '0'),
      last: parseSequence(row?.last ?? '-1'),
    };
  }

  private async connectListener(): Promise<void> {
    try {
      this.stopListening = await this.db.listen(
        [EVENT_CHANNEL],
        (_channel, payload) => this.queueNotification(payload),
        (error) => this.listenerDisconnected(error),
      );
      this.listenerReady = true;
    } catch (error) {
      this.logger.error(`database listener failed: ${errorMessage(error)}`);
      this.reconnectListener();
    }
  }

  private queueNotification(payload: string | undefined): void {
    let notification: EventNotification;
    try {
      notification = parseEventNotification(payload);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (!this.hasSubscriber(notification)) return;
    this.notifications.set(
      `${notification.eventType}:${notification.id}`,
      notification,
    );
    if (!this.notificationTimer && !this.draining) {
      this.notificationTimer = setTimeout(() => {
        this.notificationTimer = undefined;
        void this.drainNotifications().catch((error) => this.fail(error));
      }, NOTIFICATION_BATCH_MS);
    }
  }

  private async drainNotifications(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.notifications.size) {
        const batch = [...this.notifications.entries()].slice(
          0,
          NOTIFICATION_BATCH_SIZE,
        );
        const grouped = new Map<EventType, EventNotification[]>();
        for (const [key, notification] of batch) {
          this.notifications.delete(key);
          if (!this.hasSubscriber(notification)) continue;
          const group = grouped.get(notification.eventType) ?? [];
          group.push(notification);
          grouped.set(notification.eventType, group);
        }
        for (const [eventType, notifications] of grouped) {
          await this.publishNotifications(eventType, notifications);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async publishNotifications(
    eventType: EventType,
    notifications: EventNotification[],
  ): Promise<void> {
    const expected = new Map(
      notifications.map((notification) => [
        notification.id.toString(),
        notification,
      ]),
    );
    const stream = STREAMS[eventType];
    const rows = await this.db.queryLive<NotifiedRow>(
      `SELECT ${q('id')} AS ${q('notification_id')}, ${columns(stream)} FROM ${q(stream.table)} WHERE ${q('id')} = ANY($1::bigint[]) ORDER BY ${q('id')} ASC`,
      [[...expected.keys()]],
    );
    if (rows.length !== expected.size) {
      throw new Error(
        `Missing notified ${eventType} rows: expected ${expected.size}, received ${rows.length}`,
      );
    }
    const events = rows.map(({ notification_id, ...row }) => {
      const notification = expected.get(parseId(notification_id).toString());
      if (!notification)
        throw new Error(`Unexpected notified ${eventType} row`);
      if (rowDomain(row, stream.domain) !== notification.domain) {
        throw new Error(`Incorrect domain in ${eventType} notification`);
      }
      return row;
    });
    events.sort((a, b) => compareRows(eventType, a, b));
    events.forEach((row) => this.publish(eventType, row));
  }

  private hasSubscriber({ domain, eventType }: EventNotification): boolean {
    for (const client of this.clients.values()) {
      const subscription = client.subscriptions.get(eventType);
      if (subscription && matches(subscription, domain)) return true;
    }
    return false;
  }

  private listenerDisconnected(error?: Error): void {
    this.listenerReady = false;
    this.stopListening = undefined;
    this.logger.error(
      `database listener disconnected${error ? `: ${error.message}` : ''}`,
    );
    this.closeClients('Database event listener disconnected');
    this.reconnectListener();
  }

  private reconnectListener(): void {
    if (this.stopped || this.listenerRetryTimer) return;
    this.listenerRetryTimer = setTimeout(() => {
      this.listenerRetryTimer = undefined;
      void this.connectListener();
    }, LISTENER_RETRY_MS);
  }

  private fail(error: unknown): void {
    this.logger.error(`event stream failed: ${errorMessage(error)}`);
    this.closeClients('Event stream read failed');
  }

  private closeClients(reason: string, code = 1013): void {
    this.clients.forEach((_client, socket) => socket.close(code, reason));
    this.clients.clear();
  }

  private heartbeat(): void {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        this.clients.delete(socket);
        socket.terminate();
        continue;
      }
      client.alive = false;
      socket.ping();
      this.send(socket, {
        serverTime: new Date().toISOString(),
        type: 'heartbeat',
      });
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, 'Slow websocket consumer');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
}

function subscriptionResponse(request: StreamRequest): Record<string, unknown> {
  return {
    cursors: request.cursors?.map(({ address, afterSequence, domain }) => ({
      address: displayAddress(address),
      afterSequence: afterSequence?.toString(),
      domain,
    })),
    domains: request.domains ? [...request.domains] : undefined,
    eventType: request.eventType,
  };
}

function consumeMessage(client: Client): boolean {
  const now = Date.now();
  if (now - client.messageWindow >= 60_000) {
    client.messageWindow = now;
    client.messages = 0;
  }
  return ++client.messages <= MAX_CLIENT_MESSAGES;
}

function matches(subscription: Subscription, domain: number): boolean {
  return !subscription.domains || subscription.domains.has(domain);
}

function columns(stream: Stream): string {
  return stream.columns.map(q).join(', ');
}

function sequenceConfig(stream: Stream): NonNullable<Stream['sequence']> {
  if (!stream.sequence) throw new Error('Stream has no native sequence');
  return stream.sequence;
}

function rowDomain(row: Row, column: string): number {
  const value = row[column];
  const domain = typeof value === 'string' ? Number(value) : value;
  if (!isDomain(domain)) throw new Error(`Invalid ${column} in event row`);
  return domain;
}

function rowSequence(
  eventType: EventType,
  row: Row,
): { address: string; value: bigint } | undefined {
  const sequence = STREAMS[eventType].sequence;
  if (!sequence) return undefined;
  const address = row[sequence.address];
  if (typeof address !== 'string') {
    throw new Error(`Invalid ${sequence.address} in event row`);
  }
  return {
    address: normalizeAddress(address),
    value: parseSequence(row[sequence.value]),
  };
}

function parseSequence(value: unknown): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= -1) ||
    (typeof value === 'string' && /^(?:-1|\d+)$/.test(value))
  ) {
    return BigInt(value);
  }
  throw new Error('Invalid event sequence');
}

function sequenceKey(domain: number, address: string): string {
  return `${domain}:${normalizeAddress(address)}`;
}

function compareRows(eventType: EventType, a: Row, b: Row): number {
  const left = rowSequence(eventType, a)?.value;
  const right = rowSequence(eventType, b)?.value;
  return left === undefined || right === undefined || left === right
    ? 0
    : left < right
      ? -1
      : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawData(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
