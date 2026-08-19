import type { Server } from 'node:http';

import { Logger } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { config } from '../config.js';
import { DbService } from '../db/db.service.js';
import { quoteIdentifier } from '../scraperdb/tables.js';
import {
  type ClientMessage,
  EVENT_TYPES,
  type EventNotification,
  type EventType,
  isDomain,
  parseClientMessage,
  parseCursor,
  parseEventNotification,
  type SequenceCursor,
  type StreamRequest,
} from './protocol.js';

const WS_PATH = '/ws';
const EVENT_CHANNEL = 'scraper_event';
const MAX_CLIENTS = 500;
const MAX_CLIENT_MESSAGES_PER_MINUTE = 30;
const MAX_PENDING_EVENTS = 5_000;
const MAX_BUFFERED_BYTES = 1_048_576;
const HEARTBEAT_INTERVAL_MS = 30_000;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_INTERVAL_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;

type EventRow = Record<string, unknown>;
type NotifiedEventRow = EventRow & { notification_id: number | string };

type StreamDefinition = {
  addressColumn?: string;
  columns: readonly string[];
  domainColumn: string;
  sequenceColumn?: string;
  table: string;
};

const STREAMS: Record<EventType, StreamDefinition> = {
  dispatch: {
    table: 'raw_message_dispatch',
    domainColumn: 'origin_domain',
    addressColumn: 'origin_mailbox',
    sequenceColumn: 'nonce',
    columns: [
      'time_created',
      'msg_id',
      'origin_tx_hash',
      'origin_block_hash',
      'origin_block_height',
      'nonce',
      'origin_domain',
      'destination_domain',
      'sender',
      'recipient',
      'origin_mailbox',
      'msg_body',
    ],
  },
  delivery: {
    table: 'delivered_message',
    domainColumn: 'domain',
    columns: [
      'time_created',
      'msg_id',
      'domain',
      'destination_mailbox',
      'destination_tx_id',
      'sequence',
    ],
  },
  gas_payment: {
    table: 'gas_payment',
    domainColumn: 'domain',
    columns: [
      'time_created',
      'domain',
      'msg_id',
      'payment',
      'gas_amount',
      'tx_id',
      'log_index',
      'origin',
      'destination',
      'interchain_gas_paymaster',
      'sequence',
    ],
  },
  merkle_tree_insertion: {
    table: 'merkle_tree_insertion',
    domainColumn: 'domain',
    addressColumn: 'merkle_tree_hook',
    sequenceColumn: 'leaf_index',
    columns: [
      'domain',
      'merkle_tree_hook',
      'leaf_index',
      'message_id',
      'block_number',
    ],
  },
};

type Subscription = {
  catchingUp: boolean;
  domains?: Set<number>;
  pending: EventRow[];
  sequenceCursors: Map<string, bigint>;
};

type ClientState = {
  isAlive: boolean;
  messageCount: number;
  messageWindowStartedAt: number;
  subscriptions: Map<EventType, Subscription>;
};

export class EventWebSocketServer {
  private readonly logger = new Logger(EventWebSocketServer.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerReady = false;
  private listenerRetryTimer?: NodeJS.Timeout;
  private notificationBatchTimer?: NodeJS.Timeout;
  private notificationDrainRunning = false;
  private readonly pendingNotifications = new Map<
    EventType,
    Map<string, EventNotification>
  >();
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private webSocketServer?: WebSocketServer;

  constructor(private readonly db: DbService) {}

  async start(server: Server): Promise<void> {
    await this.connectListener();

    this.webSocketServer = new WebSocketServer({
      maxPayload: 4_096,
      path: WS_PATH,
      server,
    });
    this.webSocketServer.on('connection', (socket) =>
      this.onConnection(socket),
    );

    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );

    this.logger.log(
      `event websocket listening on ${WS_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.listenerRetryTimer) clearTimeout(this.listenerRetryTimer);
    if (this.notificationBatchTimer) clearTimeout(this.notificationBatchTimer);
    this.pendingNotifications.clear();
    await this.stopListening?.();
    for (const socket of this.clients.keys())
      socket.close(1001, 'Server stopping');
    this.clients.clear();

    const server = this.webSocketServer;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private onConnection(socket: WebSocket): void {
    if (!this.listenerReady) {
      socket.close(1013, 'Database event listener unavailable');
      return;
    }
    if (this.clients.size >= MAX_CLIENTS) {
      socket.close(1013, 'Maximum websocket clients reached');
      return;
    }

    this.clients.set(socket, {
      isAlive: true,
      messageCount: 0,
      messageWindowStartedAt: Date.now(),
      subscriptions: new Map(),
    });
    this.send(socket, {
      eventTypes: EVENT_TYPES,
      type: 'ready',
    });

    socket.on('pong', () => {
      const state = this.clients.get(socket);
      if (state) state.isAlive = true;
    });
    socket.on('message', (data) => {
      void this.onClientMessage(socket, rawDataToString(data));
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      this.clients.delete(socket);
    });
  }

  private async onClientMessage(socket: WebSocket, raw: string): Promise<void> {
    const state = this.clients.get(socket);
    if (!state) return;

    if (!consumeMessageQuota(state)) {
      this.sendError(socket, 'Client message rate limit exceeded');
      socket.close(1008, 'Client message rate limit exceeded');
      return;
    }

    let message: ClientMessage;
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

    if (state.subscriptions.size > 0) {
      this.sendError(socket, 'Already subscribed');
      return;
    }

    state.subscriptions.clear();
    for (const request of message.streams) {
      state.subscriptions.set(request.eventType, {
        catchingUp: request.cursors !== undefined,
        domains: request.domains,
        pending: [],
        sequenceCursors: new Map(),
      });
    }

    this.send(socket, {
      streams: message.streams.map(subscriptionResponse),
      type: 'subscribed',
    });

    await Promise.all(
      message.streams
        .filter((request) => request.cursors)
        .map((request) =>
          this.catchUp(socket, state, request).catch((error) => {
            state.subscriptions.delete(request.eventType);
            this.logger.warn(
              `websocket catch-up failed eventType=${request.eventType}: ${errorMessage(error)}`,
            );
            this.sendError(
              socket,
              `Failed to catch up ${request.eventType}: ${errorMessage(error)}`,
            );
          }),
        ),
    );
  }

  private async catchUp(
    socket: WebSocket,
    state: ClientState,
    request: StreamRequest,
  ): Promise<void> {
    const subscription = state.subscriptions.get(request.eventType);
    if (!subscription) return;
    for (const cursor of request.cursors ?? []) {
      await this.catchUpSequenceCursor(
        socket,
        state,
        request.eventType,
        subscription,
        cursor,
      );
    }

    const pending = subscription.pending.sort((left, right) =>
      compareEventRows(request.eventType, left, right),
    );
    subscription.pending = [];
    for (const row of pending) {
      if (!this.deliverRow(socket, request.eventType, subscription, row))
        return;
    }
    subscription.catchingUp = false;
  }

  private async catchUpSequenceCursor(
    socket: WebSocket,
    state: ClientState,
    eventType: EventType,
    subscription: Subscription,
    cursor: SequenceCursor,
  ): Promise<void> {
    const key = sequenceCursorKey(cursor.domain, cursor.address);
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
    subscription.sequenceCursors.set(key, after);

    while ((subscription.sequenceCursors.get(key) ?? -1n) < last) {
      if (state.subscriptions.get(eventType) !== subscription) return;
      const current = subscription.sequenceCursors.get(key) ?? -1n;
      const rows = await this.fetchSequenceRows(
        eventType,
        cursor,
        current,
        last,
      );
      if (rows.length === 0) {
        throw new Error(`Missing ${eventType} sequence ${current + 1n}`);
      }
      for (const row of rows) {
        if (!this.deliverRow(socket, eventType, subscription, row)) {
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

  private publishRow(eventType: EventType, row: EventRow): void {
    const domain = domainFromRow(row, STREAMS[eventType].domainColumn);

    for (const [socket, state] of this.clients) {
      const subscription = state.subscriptions.get(eventType);
      if (!subscription) continue;

      if (subscription.catchingUp) {
        if (matchesDomain(subscription, domain)) {
          subscription.pending.push(row);
          if (subscription.pending.length > MAX_PENDING_EVENTS) {
            socket.close(1013, 'Event catch-up buffer exceeded');
          }
        }
        continue;
      }

      this.deliverRow(socket, eventType, subscription, row);
    }
  }

  private deliverRow(
    socket: WebSocket,
    eventType: EventType,
    subscription: Subscription,
    row: EventRow,
  ): boolean {
    const domain = domainFromRow(row, STREAMS[eventType].domainColumn);
    if (!matchesDomain(subscription, domain)) return true;

    const sequence = sequenceFromRow(eventType, row);
    if (sequence) {
      const key = sequenceCursorKey(domain, sequence.address);
      const current = subscription.sequenceCursors.get(key);
      if (current !== undefined) {
        if (sequence.value <= current) return true;
        if (sequence.value !== current + 1n) {
          socket.close(
            1013,
            `${eventType} sequence gap: expected ${current + 1n}, received ${sequence.value}`,
          );
          return false;
        }
        subscription.sequenceCursors.set(key, sequence.value);
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

  private async fetchSequenceRows(
    eventType: EventType,
    cursor: SequenceCursor,
    after: bigint,
    through: bigint,
  ): Promise<EventRow[]> {
    const stream = STREAMS[eventType];
    const sequenceColumn = requiredSequenceColumn(stream);
    const addressColumn = requiredAddressColumn(stream);

    const columns = stream.columns
      .map((column) => quoteIdentifier(column))
      .join(', ');
    return this.db.queryLive<EventRow>(
      `SELECT ${columns} FROM ${quoteIdentifier(stream.table)} WHERE ${quoteIdentifier(
        stream.domainColumn,
      )} = $1 AND ${quoteIdentifier(addressColumn)} = $2::bytea AND ${quoteIdentifier(
        sequenceColumn,
      )} > $3::bigint AND ${quoteIdentifier(
        sequenceColumn,
      )} <= $4::bigint ORDER BY ${quoteIdentifier(
        sequenceColumn,
      )} ASC LIMIT $5`,
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
    const sequenceColumn = requiredSequenceColumn(stream);
    const addressColumn = requiredAddressColumn(stream);
    const [row] = await this.db.queryLive<{ first: string; last: string }>(
      `SELECT COALESCE(MIN(${quoteIdentifier(
        sequenceColumn,
      )}), 0)::text AS first, COALESCE(MAX(${quoteIdentifier(
        sequenceColumn,
      )}), -1)::text AS last FROM ${quoteIdentifier(
        stream.table,
      )} WHERE ${quoteIdentifier(stream.domainColumn)} = $1 AND ${quoteIdentifier(
        addressColumn,
      )} = $2::bytea`,
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
        (_channel, payload) => this.onNotification(payload),
        (error) => this.onListenerDisconnect(error),
      );
      this.listenerReady = true;
    } catch (error) {
      this.logger.error(`database listener failed: ${errorMessage(error)}`);
      this.scheduleListenerReconnect();
    }
  }

  private onNotification(payload: string | undefined): void {
    let notification: EventNotification;
    try {
      notification = parseEventNotification(payload);
    } catch (error) {
      this.failStream(error);
      return;
    }
    if (!this.hasMatchingSubscriber(notification)) return;

    let eventNotifications = this.pendingNotifications.get(
      notification.eventType,
    );
    if (!eventNotifications) {
      eventNotifications = new Map();
      this.pendingNotifications.set(notification.eventType, eventNotifications);
    }
    eventNotifications.set(notification.id.toString(), notification);
    this.scheduleNotificationDrain();
  }

  private hasMatchingSubscriber(notification: EventNotification): boolean {
    for (const state of this.clients.values()) {
      const subscription = state.subscriptions.get(notification.eventType);
      if (subscription && matchesDomain(subscription, notification.domain)) {
        return true;
      }
    }
    return false;
  }

  private scheduleNotificationDrain(): void {
    if (this.notificationBatchTimer || this.notificationDrainRunning) return;
    this.notificationBatchTimer = setTimeout(() => {
      this.notificationBatchTimer = undefined;
      void this.drainNotifications().catch((error) => this.failStream(error));
    }, NOTIFICATION_BATCH_INTERVAL_MS);
  }

  private async drainNotifications(): Promise<void> {
    if (this.notificationDrainRunning) return;
    this.notificationDrainRunning = true;
    try {
      while (this.pendingNotifications.size > 0) {
        for (const eventType of EVENT_TYPES) {
          const notifications = this.takeNotificationBatch(eventType);
          if (notifications.length > 0) {
            await this.publishNotificationBatch(eventType, notifications);
          }
        }
      }
    } finally {
      this.notificationDrainRunning = false;
      if (this.pendingNotifications.size > 0) this.scheduleNotificationDrain();
    }
  }

  private takeNotificationBatch(eventType: EventType): EventNotification[] {
    const queued = this.pendingNotifications.get(eventType);
    if (!queued) return [];

    const batch: EventNotification[] = [];
    for (const [id, notification] of queued) {
      queued.delete(id);
      if (this.hasMatchingSubscriber(notification)) batch.push(notification);
      if (batch.length >= NOTIFICATION_BATCH_SIZE) break;
    }
    if (queued.size === 0) this.pendingNotifications.delete(eventType);
    return batch;
  }

  private async publishNotificationBatch(
    eventType: EventType,
    notifications: EventNotification[],
  ): Promise<void> {
    const byId = new Map(
      notifications.map((notification) => [
        notification.id.toString(),
        notification,
      ]),
    );
    const stream = STREAMS[eventType];
    const columns = stream.columns
      .map((column) => quoteIdentifier(column))
      .join(', ');
    const rows = await this.db.queryLive<NotifiedEventRow>(
      `SELECT ${quoteIdentifier('id')} AS ${quoteIdentifier(
        'notification_id',
      )}, ${columns} FROM ${quoteIdentifier(
        stream.table,
      )} WHERE ${quoteIdentifier(
        'id',
      )} = ANY($1::bigint[]) ORDER BY ${quoteIdentifier('id')} ASC`,
      [[...byId.keys()]],
    );
    if (rows.length !== byId.size) {
      throw new Error(
        `Missing notified ${eventType} rows: expected ${byId.size}, received ${rows.length}`,
      );
    }

    const eventRows = rows.map(({ notification_id: rawId, ...row }) => {
      const id = parseCursor(rawId).toString();
      const notification = byId.get(id);
      if (!notification) throw new Error(`Unexpected notified row ${id}`);
      const domain = domainFromRow(row, stream.domainColumn);
      if (domain !== notification.domain) {
        throw new Error(`Incorrect domain in ${eventType} notification`);
      }
      return row;
    });
    eventRows.sort((left, right) => compareEventRows(eventType, left, right));
    for (const row of eventRows) this.publishRow(eventType, row);
  }

  private onListenerDisconnect(error?: Error): void {
    this.listenerReady = false;
    this.stopListening = undefined;
    this.logger.error(
      `database listener disconnected${error ? `: ${error.message}` : ''}`,
    );
    this.closeClients('Database event listener disconnected');
    this.scheduleListenerReconnect();
  }

  private scheduleListenerReconnect(): void {
    if (this.stopped || this.listenerRetryTimer) return;
    this.listenerRetryTimer = setTimeout(() => {
      this.listenerRetryTimer = undefined;
      void this.connectListener();
    }, LISTENER_RETRY_MS);
  }

  private failStream(error: unknown): void {
    this.logger.error(`event stream failed: ${errorMessage(error)}`);
    this.closeClients('Event stream read failed');
  }

  private closeClients(reason: string): void {
    for (const socket of this.clients.keys()) socket.close(1013, reason);
    this.clients.clear();
  }

  private heartbeat(): void {
    for (const [socket, state] of this.clients) {
      if (!state.isAlive) {
        this.clients.delete(socket);
        socket.terminate();
        continue;
      }
      state.isAlive = false;
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

function consumeMessageQuota(state: ClientState): boolean {
  const now = Date.now();
  if (now - state.messageWindowStartedAt >= 60_000) {
    state.messageWindowStartedAt = now;
    state.messageCount = 1;
    return true;
  }
  state.messageCount += 1;
  return state.messageCount <= MAX_CLIENT_MESSAGES_PER_MINUTE;
}

function matchesDomain(subscription: Subscription, domain: number): boolean {
  return !subscription.domains || subscription.domains.has(domain);
}

function domainFromRow(row: EventRow, column: string): number {
  const value = row[column];
  const domain = typeof value === 'string' ? Number(value) : value;
  if (!isDomain(domain)) throw new Error(`Invalid ${column} in event row`);
  return domain;
}

function sequenceFromRow(
  eventType: EventType,
  row: EventRow,
): { address: string; value: bigint } | undefined {
  const stream = STREAMS[eventType];
  if (!stream.sequenceColumn || !stream.addressColumn) return undefined;

  const address = row[stream.addressColumn];
  if (typeof address !== 'string') {
    throw new Error(`Invalid ${stream.addressColumn} in event row`);
  }
  return {
    address: normalizeDatabaseAddress(address),
    value: parseSequence(row[stream.sequenceColumn]),
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

function sequenceCursorKey(domain: number, address: string): string {
  return `${domain}:${normalizeDatabaseAddress(address)}`;
}

function normalizeDatabaseAddress(address: string): string {
  const hex = address.replace(/^(?:0x|\\x)/, '').toLowerCase();
  return `\\x${hex}`;
}

function displayAddress(address: string): string {
  return `0x${normalizeDatabaseAddress(address).slice(2)}`;
}

function requiredSequenceColumn(stream: StreamDefinition): string {
  if (!stream.sequenceColumn) throw new Error('Stream has no native sequence');
  return stream.sequenceColumn;
}

function requiredAddressColumn(stream: StreamDefinition): string {
  if (!stream.addressColumn) throw new Error('Stream has no sequence scope');
  return stream.addressColumn;
}

function compareEventRows(
  eventType: EventType,
  left: EventRow,
  right: EventRow,
): number {
  const leftSequence = sequenceFromRow(eventType, left)?.value;
  const rightSequence = sequenceFromRow(eventType, right)?.value;
  if (leftSequence === undefined || rightSequence === undefined) return 0;
  return leftSequence < rightSequence
    ? -1
    : leftSequence > rightSequence
      ? 1
      : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
