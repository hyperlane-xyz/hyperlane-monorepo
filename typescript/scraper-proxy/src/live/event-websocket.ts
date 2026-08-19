import type { Server } from 'node:http';

import { Logger } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { config } from '../config.js';
import { DbService } from '../db/db.service.js';
import { quoteIdentifier } from '../scraperdb/tables.js';
import {
  type ClientMessage,
  EVENT_TYPES,
  type EventType,
  isDomain,
  parseClientMessage,
  parseCursor,
  parseEventNotification,
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

type EventRow = Record<string, unknown> & { id: number | string };

type StreamDefinition = {
  columns: readonly string[];
  domainColumn: string;
  table: string;
};

const STREAMS: Record<EventType, StreamDefinition> = {
  dispatch: {
    table: 'raw_message_dispatch',
    domainColumn: 'origin_domain',
    columns: [
      'id',
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
      'id',
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
      'id',
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
    columns: [
      'id',
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
  cursor: bigint;
  domains?: Set<number>;
  pending: EventRow[];
  pendingMaxCursor: bigint;
};

type ClientState = {
  isAlive: boolean;
  messageCount: number;
  messageWindowStartedAt: number;
  subscriptions: Map<EventType, Subscription>;
};

type Tip = {
  domain: number;
  eventType: 'scraper';
  height: string;
  recordedAt: unknown;
};

export class EventWebSocketServer {
  private readonly logger = new Logger(EventWebSocketServer.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly tips = new Map<number, Tip>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerReady = false;
  private listenerRetryTimer?: NodeJS.Timeout;
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private webSocketServer?: WebSocketServer;

  constructor(private readonly db: DbService) {}

  async start(server: Server): Promise<void> {
    await this.connectListener();
    await this.refreshTips();

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
        catchingUp: true,
        cursor: request.afterId ?? 0n,
        domains: request.domains,
        pending: [],
        pendingMaxCursor: 0n,
      });
    }

    this.send(socket, {
      streams: message.streams.map(subscriptionResponse),
      type: 'subscribed',
    });

    await Promise.all(
      message.streams.map((request) =>
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

    const upper = await this.maxId(request.eventType);
    if (request.afterId !== undefined && request.afterId > upper) {
      throw new Error(
        `Cursor ${request.afterId} is ahead of current ${request.eventType} cursor ${upper}`,
      );
    }

    if (request.afterId === undefined) {
      subscription.cursor = upper;
    } else {
      while (subscription.cursor < upper) {
        if (state.subscriptions.get(request.eventType) !== subscription) return;
        const rows = await this.fetchRows(
          request.eventType,
          subscription.cursor,
          upper,
          request.domains,
        );
        for (const row of rows) {
          this.deliverRow(socket, request.eventType, subscription, row);
        }
        if (rows.length < config.EVENT_STREAM_BATCH_SIZE) break;
      }
      subscription.cursor = upper;
    }

    if (state.subscriptions.get(request.eventType) !== subscription) return;
    this.send(socket, {
      cursor: upper.toString(),
      eventType: request.eventType,
      type: 'caught_up',
    });

    const pending = subscription.pending.sort((left, right) =>
      compareCursor(cursorFromRow(left), cursorFromRow(right)),
    );
    subscription.pending = [];
    for (const row of pending) {
      this.deliverRow(socket, request.eventType, subscription, row, true);
    }
    subscription.cursor = maxBigInt(
      subscription.cursor,
      subscription.pendingMaxCursor,
    );
    subscription.catchingUp = false;
  }

  private publishRow(eventType: EventType, row: EventRow): void {
    const rowCursor = cursorFromRow(row);
    const domain = domainFromRow(row, STREAMS[eventType].domainColumn);

    for (const [socket, state] of this.clients) {
      const subscription = state.subscriptions.get(eventType);
      if (!subscription) continue;

      if (subscription.catchingUp) {
        subscription.pendingMaxCursor = maxBigInt(
          subscription.pendingMaxCursor,
          rowCursor,
        );
        if (matchesDomain(subscription, domain)) {
          subscription.pending.push(row);
          if (subscription.pending.length > MAX_PENDING_EVENTS) {
            socket.close(1013, 'Event catch-up buffer exceeded');
          }
        }
        continue;
      }

      this.deliverRow(socket, eventType, subscription, row, true);
    }
  }

  private deliverRow(
    socket: WebSocket,
    eventType: EventType,
    subscription: Subscription,
    row: EventRow,
    allowOlder = false,
  ): void {
    const rowCursor = cursorFromRow(row);
    if (!allowOlder && rowCursor <= subscription.cursor) return;

    const domain = domainFromRow(row, STREAMS[eventType].domainColumn);
    if (matchesDomain(subscription, domain)) {
      this.send(socket, {
        cursor: rowCursor.toString(),
        data: row,
        domain,
        eventType,
        tip: this.tips.get(domain),
        type: 'event',
      });
    }
    subscription.cursor = maxBigInt(subscription.cursor, rowCursor);
  }

  private async fetchRows(
    eventType: EventType,
    after: bigint,
    through?: bigint,
    domains?: Set<number>,
  ): Promise<EventRow[]> {
    const stream = STREAMS[eventType];
    const values: unknown[] = [after.toString()];
    const predicates = [`${quoteIdentifier('id')} > $1::bigint`];

    if (through !== undefined) {
      values.push(through.toString());
      predicates.push(`${quoteIdentifier('id')} <= $${values.length}::bigint`);
    }
    if (domains) {
      values.push([...domains]);
      predicates.push(
        `${quoteIdentifier(stream.domainColumn)} = ANY($${values.length}::integer[])`,
      );
    }
    values.push(config.EVENT_STREAM_BATCH_SIZE);

    const columns = stream.columns
      .map((column) => quoteIdentifier(column))
      .join(', ');
    return this.db.queryLive<EventRow>(
      `SELECT ${columns} FROM ${quoteIdentifier(stream.table)} WHERE ${predicates.join(
        ' AND ',
      )} ORDER BY ${quoteIdentifier('id')} ASC LIMIT $${values.length}`,
      values,
    );
  }

  private async maxId(eventType: EventType): Promise<bigint> {
    const table = STREAMS[eventType].table;
    const [row] = await this.db.queryLive<{ id: string }>(
      `SELECT COALESCE(MAX(${quoteIdentifier('id')}), 0)::text AS id FROM ${quoteIdentifier(table)}`,
    );
    return parseCursor(row?.id ?? '0');
  }

  private async refreshTips(): Promise<void> {
    type TipRow = {
      domain: number;
      height: string;
      time_created: unknown;
    };
    const sql = `SELECT ${quoteIdentifier('domain')}, ${quoteIdentifier(
      'height',
    )}::text AS ${quoteIdentifier('height')}, ${quoteIdentifier(
      'time_created',
    )} FROM ${quoteIdentifier('cursor')} WHERE ${quoteIdentifier(
      'event_type',
    )} = ''`;
    const rows = await this.db.queryLive<TipRow>(sql);

    for (const row of rows) {
      const tip: Tip = {
        domain: Number(row.domain),
        eventType: 'scraper',
        height: row.height,
        recordedAt: row.time_created,
      };
      this.tips.set(tip.domain, tip);
    }
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
    let notification: {
      domain: number;
      eventType: EventType;
      id: bigint;
    };
    try {
      notification = parseEventNotification(payload);
    } catch (error) {
      this.failStream(error);
      return;
    }
    void this.handleEventNotification(notification).catch((error) =>
      this.failStream(error),
    );
  }

  private async handleEventNotification(notification: {
    domain: number;
    eventType: EventType;
    id: bigint;
  }): Promise<void> {
    const [row, tip] = await Promise.all([
      this.fetchNotifiedRow(notification.eventType, notification.id),
      this.fetchTip(notification.domain),
    ]);
    const domain = domainFromRow(
      row,
      STREAMS[notification.eventType].domainColumn,
    );
    if (domain !== notification.domain) {
      throw new Error(
        `Incorrect domain in ${notification.eventType} notification`,
      );
    }
    if (tip) {
      this.tips.set(tip.domain, tip);
    }
    this.publishRow(notification.eventType, row);
  }

  private async fetchNotifiedRow(
    eventType: EventType,
    id: bigint,
  ): Promise<EventRow> {
    const stream = STREAMS[eventType];
    const columns = stream.columns
      .map((column) => quoteIdentifier(column))
      .join(', ');
    const rows = await this.db.queryLive<EventRow>(
      `SELECT ${columns} FROM ${quoteIdentifier(stream.table)} WHERE ${quoteIdentifier(
        'id',
      )} = $1::bigint`,
      [id.toString()],
    );
    if (rows.length !== 1) {
      throw new Error(`Missing notified ${eventType} row ${id}`);
    }
    return rows[0];
  }

  private async fetchTip(domain: number): Promise<Tip | null> {
    const rows = await this.db.queryLive<{
      height: string;
      time_created: unknown;
    }>(
      `SELECT ${quoteIdentifier('height')}::text AS ${quoteIdentifier(
        'height',
      )}, ${quoteIdentifier('time_created')} FROM ${quoteIdentifier(
        'cursor',
      )} WHERE ${quoteIdentifier('domain')} = $1 AND ${quoteIdentifier(
        'event_type',
      )} = ''`,
      [domain],
    );
    const row = rows[0];
    return row
      ? {
          domain,
          eventType: 'scraper',
          height: row.height,
          recordedAt: row.time_created,
        }
      : null;
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
    afterId: request.afterId?.toString(),
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

function cursorFromRow(row: EventRow): bigint {
  return parseCursor(row.id);
}

function domainFromRow(row: EventRow, column: string): number {
  const value = row[column];
  const domain = typeof value === 'string' ? Number(value) : value;
  if (!isDomain(domain)) throw new Error(`Invalid ${column} in event row`);
  return domain;
}

function compareCursor(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
