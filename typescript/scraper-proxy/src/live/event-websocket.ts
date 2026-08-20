import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { Logger } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';

import { config } from '../config.js';
import type { DbService } from '../db/db.service.js';
import { quoteIdentifier as q, tables } from '../scraperdb/tables.js';
import {
  displayAddress,
  EVENT_TYPES,
  type EventNotification,
  type EventType,
  isDomain,
  isSequencedEventType,
  normalizeAddress,
  parseClientMessage,
  parseEventNotification,
  parseExplorerNotification,
  parseId,
  parseInteger,
  type SequenceCursor,
  type StreamRequest,
} from './protocol.js';
import { rawData } from './websocket-data.js';

const AGENT_PATH = '/agents';
const EXPLORER_PATH = '/explorer';
const EVENT_CHANNEL = 'scraper_event';
const EXPLORER_CHANNEL = 'scraper_explorer_event';
const HEARTBEAT_MS = 30_000;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;
const MAX_AGENT_CLIENTS = 100;
const MAX_EXPLORER_CLIENTS = 400;
const MAX_CLIENT_MESSAGES = 30;
const MAX_PENDING_EVENTS = 5_000;

type Row = Record<string, unknown>;
type NotifiedRow = Row & { notification_id: number | string };
type Stream = {
  columns: readonly string[];
  domain: string;
  projection: string;
  sequence?: { address: string; value: string };
  table: string;
};
type Subscription = {
  catchUpRows: number;
  catchUpStartedAt: number;
  catchingUp: boolean;
  cursorKeys?: Set<string>;
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
type Limits = {
  maxAgentClients: number;
  maxBufferedBytes: number;
  maxCatchUpMs: number;
  maxCatchUpRows: number;
  maxConcurrentCatchUps: number;
  maxExplorerClients: number;
  maxTotalBufferedBytes: number;
};
type SerializedMessage = { bytes: number; text: string };
export type EventDatabase = Pick<DbService, 'listen' | 'queryLive'>;

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

const STREAMS: Record<EventType, Stream> = {
  dispatch: stream(
    'raw_message_dispatch',
    'origin_domain',
    tables.raw_message_dispatch.columns,
    'origin_mailbox',
    'nonce',
  ),
  delivery: stream(
    'delivered_message',
    'domain',
    'time_created msg_id domain destination_mailbox destination_tx_id sequence'.split(
      ' ',
    ),
  ),
  gas_payment: stream(
    'gas_payment',
    'domain',
    'time_created domain msg_id payment gas_amount tx_id log_index origin destination interchain_gas_paymaster sequence'.split(
      ' ',
    ),
  ),
  merkle_tree_insertion: stream(
    'merkle_tree_insertion',
    'domain',
    'domain merkle_tree_hook leaf_index message_id block_number'.split(' '),
    'merkle_tree_hook',
    'leaf_index',
  ),
};

export class EventWebSocketServer {
  private readonly logger = new Logger(EventWebSocketServer.name);
  private readonly clients = new Map<WebSocket, Client>();
  private readonly explorerClients = new Map<WebSocket, { alive: boolean }>();
  private readonly explorerNotifications = new Set<string>();
  private readonly notifications = new Map<string, EventNotification>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerRetryTimer?: NodeJS.Timeout;
  private notificationTimer?: NodeJS.Timeout;
  private draining = false;
  private catchUps = 0;
  private pendingBytes = 0;
  private listenerReady = false;
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private httpServer?: Server;
  private agentServer?: WebSocketServer;
  private explorerServer?: WebSocketServer;
  private readonly limits: Limits;

  constructor(
    private readonly db: EventDatabase,
    private readonly historyEnabled = config.EVENT_STREAM_HISTORY_ENABLED,
    limits: Partial<Limits> = {},
  ) {
    this.limits = {
      maxAgentClients: MAX_AGENT_CLIENTS,
      maxBufferedBytes: config.EVENT_STREAM_MAX_BUFFERED_BYTES,
      maxCatchUpMs: config.EVENT_STREAM_HISTORY_MAX_MS,
      maxCatchUpRows: config.EVENT_STREAM_HISTORY_MAX_ROWS,
      maxConcurrentCatchUps: config.EVENT_STREAM_HISTORY_MAX_CONCURRENT,
      maxExplorerClients: MAX_EXPLORER_CLIENTS,
      maxTotalBufferedBytes: config.EVENT_STREAM_MAX_TOTAL_BUFFERED_BYTES,
      ...limits,
    };
  }

  async start(server: Server): Promise<void> {
    await this.connectListener();
    this.agentServer = new WebSocketServer({
      maxPayload: 4_096,
      noServer: true,
    });
    this.explorerServer = new WebSocketServer({
      maxPayload: 4_096,
      noServer: true,
    });
    this.httpServer = server;
    server.on('upgrade', this.handleUpgrade);
    this.agentServer.on('connection', (socket) => this.connectAgent(socket));
    this.explorerServer.on('connection', (socket) =>
      this.connectExplorer(socket),
    );
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.logger.log(
      `event websockets listening on ${AGENT_PATH}, ${EXPLORER_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE} historyEnabled=${this.historyEnabled} maxBufferedBytes=${this.limits.maxBufferedBytes} maxTotalBufferedBytes=${this.limits.maxTotalBufferedBytes}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    [
      this.heartbeatTimer,
      this.listenerRetryTimer,
      this.notificationTimer,
    ].forEach((timer) => timer && clearTimeout(timer));
    this.explorerNotifications.clear();
    this.notifications.clear();
    await this.stopListening?.();
    this.httpServer?.off('upgrade', this.handleUpgrade);
    this.closeClients('Server stopping', 1001);
    await Promise.all(
      [this.agentServer, this.explorerServer].map((websocketServer) =>
        websocketServer
          ? new Promise<void>((resolve, reject) =>
              websocketServer.close((error) =>
                error ? reject(error) : resolve(),
              ),
            )
          : Promise.resolve(),
      ),
    );
  }

  private connectAgent(socket: WebSocket): void {
    if (!this.accept(socket, 'agent')) return;
    this.clients.set(socket, {
      alive: true,
      messages: 0,
      messageWindow: Date.now(),
      subscriptions: new Map(),
    });
    this.send(socket, {
      eventTypes: EVENT_TYPES,
      historicalStreaming: this.historyEnabled,
      type: 'ready',
    });
    this.watch(socket, this.clients, (client) => client.subscriptions.clear());
    socket.on('message', (data) => void this.onMessage(socket, rawData(data)));
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const path = request.url?.split('?', 1)[0];
    const websocketServer =
      path === AGENT_PATH
        ? this.agentServer
        : path === EXPLORER_PATH
          ? this.explorerServer
          : undefined;
    if (!websocketServer) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) =>
      websocketServer.emit('connection', websocket, request),
    );
  };

  private connectExplorer(socket: WebSocket): void {
    if (!this.accept(socket, 'explorer')) return;
    this.explorerClients.set(socket, { alive: true });
    this.send(socket, {
      eventTypes: ['message_upsert'],
      type: 'ready',
    });
    this.watch(socket, this.explorerClients);
  }

  private accept(socket: WebSocket, route: 'agent' | 'explorer'): boolean {
    const full =
      route === 'agent'
        ? this.clients.size >= this.limits.maxAgentClients
        : this.explorerClients.size >= this.limits.maxExplorerClients;
    if (!this.listenerReady || full) {
      socket.close(
        1013,
        this.listenerReady
          ? `Maximum ${route} websocket clients reached`
          : 'Database event listener unavailable',
      );
      return false;
    }
    return true;
  }

  private watch<T extends { alive: boolean }>(
    socket: WebSocket,
    clients: Map<WebSocket, T>,
    removed?: (client: T) => void,
  ): void {
    socket.on('pong', () => {
      const client = clients.get(socket);
      if (client) client.alive = true;
    });
    const remove = (): void => {
      const client = clients.get(socket);
      if (client) removed?.(client);
      clients.delete(socket);
    };
    socket.on('close', remove);
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      remove();
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
    if (
      !this.historyEnabled &&
      message.streams.some(({ cursors }) => cursors)
    ) {
      this.sendError(socket, 'Historical streaming is temporarily disabled');
      return;
    }
    if (client.subscriptions.size) {
      this.sendError(socket, 'Already subscribed');
      return;
    }

    for (const request of message.streams) {
      client.subscriptions.set(request.eventType, {
        catchUpRows: 0,
        catchUpStartedAt: Date.now(),
        catchingUp: !!request.cursors,
        cursorKeys: request.cursors
          ? new Set(
              request.cursors.map(({ address, domain }) =>
                sequenceKey(domain, address),
              ),
            )
          : undefined,
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
    if (this.catchUps >= this.limits.maxConcurrentCatchUps) {
      client.subscriptions.delete(request.eventType);
      this.sendError(socket, 'Historical streaming capacity exceeded');
      return;
    }
    this.catchUps++;
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
    } finally {
      this.catchUps--;
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
      this.assertCatchUpBudget(subscription);
      const rows = await this.sequenceRows(eventType, cursor, current, last);
      subscription.catchUpRows += rows.length;
      this.assertCatchUpBudget(subscription);
      if (!rows.length)
        throw new Error(`Missing ${eventType} sequence ${current + 1n}`);
      for (const row of rows) {
        if (!this.deliver(socket, eventType, subscription, row)) {
          throw new Error(`Gap in ${eventType} sequence after ${current}`);
        }
      }
    }
    if (
      !this.send(socket, {
        address: displayAddress(cursor.address),
        domain: cursor.domain,
        eventType,
        sequence: last.toString(),
        type: 'caught_up',
      })
    )
      throw new Error('Websocket closed during catch-up');
  }

  private publish(eventType: EventType, row: Row): void {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    const key = rowSequenceKey(eventType, domain, row);
    for (const [socket, client] of this.clients) {
      const subscription = client.subscriptions.get(eventType);
      if (!subscription || !matches(subscription, domain, key)) continue;
      if (!subscription.catchingUp) {
        this.deliver(socket, eventType, subscription, row);
      } else if (subscription.pending.push(row) > MAX_PENDING_EVENTS) {
        this.disconnect(socket);
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
    const key = rowSequenceKey(eventType, domain, row);
    if (!matches(subscription, domain, key)) return true;
    const sequence = rowSequence(eventType, row);
    if (sequence) {
      const sequenceCursorKey = sequenceKey(domain, sequence.address);
      const current = subscription.sequences.get(sequenceCursorKey);
      if (current !== undefined) {
        if (sequence.value <= current) return true;
        if (sequence.value !== current + 1n) {
          socket.close(
            1013,
            `${eventType} sequence gap: expected ${current + 1n}, received ${sequence.value}`,
          );
          return false;
        }
        subscription.sequences.set(sequenceCursorKey, sequence.value);
      }
    }
    return this.send(socket, {
      data: row,
      domain,
      eventType,
      sequence: sequence?.value.toString(),
      type: 'event',
    });
  }

  private assertCatchUpBudget(subscription: Subscription): void {
    if (subscription.catchUpRows > this.limits.maxCatchUpRows) {
      throw new Error(
        `Historical streaming row limit exceeded (${this.limits.maxCatchUpRows})`,
      );
    }
    if (Date.now() - subscription.catchUpStartedAt > this.limits.maxCatchUpMs) {
      throw new Error(
        `Historical streaming time limit exceeded (${this.limits.maxCatchUpMs}ms)`,
      );
    }
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
        [EVENT_CHANNEL, EXPLORER_CHANNEL],
        (channel, payload) => this.queueNotification(channel, payload),
        (error) => this.listenerDisconnected(error),
      );
      this.listenerReady = true;
    } catch (error) {
      this.logger.error(`database listener failed: ${errorMessage(error)}`);
      this.reconnectListener();
    }
  }

  private queueNotification(
    channel: string,
    payload: string | undefined,
  ): void {
    try {
      if (channel === EXPLORER_CHANNEL) {
        if (!this.explorerClients.size) return;
        this.explorerNotifications.add(
          parseExplorerNotification(payload).messageId,
        );
      } else {
        const notification = parseEventNotification(payload);
        if (!this.hasSubscriber(notification)) return;
        this.notifications.set(
          `${notification.eventType}:${notification.id}`,
          notification,
        );
      }
    } catch (error) {
      this.logger.warn(
        `skipping invalid database notification: ${errorMessage(error)}`,
      );
      return;
    }
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
      while (this.notifications.size || this.explorerNotifications.size) {
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
        if (this.explorerNotifications.size) {
          const messageIds = [...this.explorerNotifications].slice(
            0,
            NOTIFICATION_BATCH_SIZE,
          );
          messageIds.forEach((messageId) =>
            this.explorerNotifications.delete(messageId),
          );
          await this.publishExplorer(messageIds);
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
    const returned = new Set<string>();
    for (const { notification_id } of rows) {
      try {
        returned.add(parseId(notification_id).toString());
      } catch (error) {
        this.logger.warn(
          `invalid notified ${eventType} row ID: ${errorMessage(error)}`,
        );
      }
    }
    const missing = [...expected.keys()].filter((id) => !returned.has(id));
    if (missing.length) {
      this.logger.warn(
        `missing notified ${eventType} row IDs: ${missing.join(', ')}`,
      );
    }
    const events = rows.flatMap(({ notification_id, ...row }) => {
      try {
        const notification = expected.get(parseId(notification_id).toString());
        if (!notification)
          throw new Error(`Unexpected notified ${eventType} row`);
        if (rowDomain(row, stream.domain) !== notification.domain) {
          throw new Error(`Incorrect domain in ${eventType} notification`);
        }
        return [row];
      } catch (error) {
        this.logger.warn(
          `skipping invalid notified ${eventType} row: ${errorMessage(error)}`,
        );
        return [];
      }
    });
    events.sort((a, b) => compareRows(eventType, a, b));
    events.forEach((row) => this.publish(eventType, row));
  }

  private async publishExplorer(messageIds: string[]): Promise<void> {
    if (!this.explorerClients.size) return;
    const rows = await this.db.queryLive<Row>(
      `SELECT ${tables.message_view.columns.map(q).join(', ')} FROM ${q('message_view')} WHERE ${q('msg_id')} = ANY($1::bytea[])`,
      [messageIds],
    );
    for (const row of rows) {
      const message = serialize({ data: row, type: 'message_upsert' });
      this.explorerClients.forEach((_client, socket) =>
        this.sendSerialized(socket, message),
      );
    }
  }

  private hasSubscriber({ domain, eventType }: EventNotification): boolean {
    for (const client of this.clients.values()) {
      const subscription = client.subscriptions.get(eventType);
      if (subscription && matchesDomain(subscription, domain)) return true;
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
    this.explorerClients.forEach((_client, socket) =>
      socket.close(code, reason),
    );
    this.clients.clear();
    this.explorerClients.clear();
  }

  private heartbeat(): void {
    this.heartbeatClients(this.clients);
    this.heartbeatClients(this.explorerClients);
  }

  private heartbeatClients<T extends { alive: boolean }>(
    clients: Map<WebSocket, T>,
  ): void {
    for (const [socket, client] of clients) {
      if (!client.alive) {
        clients.delete(socket);
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
    return this.sendSerialized(socket, serialize(message));
  }

  private sendSerialized(
    socket: WebSocket,
    message: SerializedMessage,
  ): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (
      socket.bufferedAmount + message.bytes > this.limits.maxBufferedBytes ||
      this.pendingBytes + message.bytes > this.limits.maxTotalBufferedBytes
    ) {
      this.disconnect(socket);
      this.logger.warn('terminating websocket: outbound buffer limit exceeded');
      socket.terminate();
      return false;
    }
    this.pendingBytes += message.bytes;
    try {
      socket.send(message.text, (error) => {
        this.pendingBytes = Math.max(0, this.pendingBytes - message.bytes);
        if (!error) return;
        this.logger.warn(`websocket send failed: ${error.message}`);
        this.disconnect(socket);
        socket.terminate();
      });
    } catch (error) {
      this.pendingBytes -= message.bytes;
      this.logger.warn(`websocket send failed: ${errorMessage(error)}`);
      this.disconnect(socket);
      socket.terminate();
      return false;
    }
    return true;
  }

  private disconnect(socket: WebSocket): void {
    this.clients.get(socket)?.subscriptions.clear();
    this.clients.delete(socket);
    this.explorerClients.delete(socket);
  }

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
}

function serialize(message: Record<string, unknown>): SerializedMessage {
  const text = JSON.stringify(message);
  return { bytes: Buffer.byteLength(text), text };
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

function matches(
  subscription: Subscription,
  domain: number,
  cursorKey?: string,
): boolean {
  return (
    matchesDomain(subscription, domain) &&
    (!subscription.cursorKeys ||
      (cursorKey !== undefined && subscription.cursorKeys.has(cursorKey)))
  );
}

function matchesDomain(subscription: Subscription, domain: number): boolean {
  return !subscription.domains || subscription.domains.has(domain);
}

function columns(stream: Stream): string {
  return stream.projection;
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
  if (!isSequencedEventType(eventType)) return undefined;
  const sequence = sequenceConfig(STREAMS[eventType]);
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
  return parseInteger(value, -1, 'Invalid event sequence');
}

function sequenceKey(domain: number, address: string): string {
  return `${domain}:${normalizeAddress(address)}`;
}

function rowSequenceKey(
  eventType: EventType,
  domain: number,
  row: Row,
): string | undefined {
  const sequence = rowSequence(eventType, row);
  return sequence && sequenceKey(domain, sequence.address);
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
