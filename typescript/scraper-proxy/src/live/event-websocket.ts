import type { IncomingMessage, Server } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';

import { rootLogger } from '@hyperlane-xyz/utils';
import { formatError } from '@hyperlane-xyz/utils/errors';
import { WebSocket, WebSocketServer } from 'ws';

import { config } from '../config.js';
import type { DbService } from '../db/db.service.js';
import {
  type WebSocketMetricsSnapshot,
  websocketCatchUps,
  websocketClientMessageRejections,
  websocketConnectionRejections,
  websocketConnections,
  websocketNotificationQueueOverflows,
  websocketSendFailures,
} from '../metrics.js';
import {
  displayAddress,
  SUBSCRIPTION_TYPES,
  type BlockStreamRequest,
  type EventNotification,
  type EventType,
  parseDatabaseDomain,
  parseClientMessage,
  parseEventNotification,
  parseExplorerNotification,
  parseExplorerConfirmations,
  parseExplorerBlocks,
  parseOptionalBlockHash,
  parseHeadNotification,
  parseId,
  type StreamRequest,
  STREAM_CURSOR_VERSIONS,
} from './protocol.js';
import {
  ConfirmationStream,
  ConfirmationUnavailableError,
} from './confirmation-stream.js';
import {
  type Row,
  STREAMS,
  compareRows,
  rowCursorKey,
  rowDomain,
  EventStore,
} from './event-store.js';
import { rawData } from './websocket-data.js';
import { NotificationWorker } from './notification-worker.js';
import { AgentSubscription, MAX_PENDING_EVENTS } from './agent-subscription.js';

// Explorer types first: a failure in an agent-only type must not close Explorer
// clients that already received this range. No cross-type order is promised.
const HEAD_PUBLICATION_ORDER = [
  'delivery',
  'gas_payment',
  'dispatch',
  'merkle_tree_insertion',
] as const satisfies readonly EventType[];

const AGENT_PATH = '/agents';
const MAX_AGENT_MESSAGE_BYTES = 1_048_576;
const MESSAGE_PATH = '/messages';
const EVENT_CHANNEL = 'scraper_event';
const EXPLORER_CHANNEL = 'scraper_explorer_event';
const HEAD_CHANNEL = 'scraper_head';
const HEARTBEAT_MS = 30_000;
// Node's setInterval() warns and clamps to 1 for non-positive values and
// overflows above a signed 32-bit integer, so heartbeat overrides must stay
// in this range.
const MAX_INTERVAL_MS = 2_147_483_647;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;
const EXPLORER_NOTIFICATION_BATCH_SIZE = 100;
const MAX_EXPLORER_CLIENTS = 400;
const MAX_EXPLORER_CLIENTS_PER_IP = 5;
const MAX_EXPLORER_PENDING_BYTES = 16_777_216;
const MAX_EXPLORER_PENDING_MESSAGES = 2_000;
const MAX_CLIENT_MESSAGES = 30;
const MAX_PENDING_NOTIFICATIONS = 10_000;
const MAX_HEAD_PUBLICATION_FAILURES = 3;
type Client = {
  alive: boolean;
  messages: number;
  messageWindow: number;
  subscriptions: Map<EventType, AgentSubscription>;
  subscribing: boolean;
};
type ExplorerClient = {
  alive: boolean;
  custom: boolean;
  ip: string;
  queuedBytes: number;
  queue: SerializedMessage[];
  sending: boolean;
};
type CatchUpWaiter = {
  resolve: (reserved: boolean) => void;
  socket: WebSocket;
};
type Limits = {
  heartbeatMs: number;
  maxAgentClients: number;
  maxBufferedBytes: number;
  maxCatchUpMs: number;
  maxConcurrentCatchUps: number;
  maxExplorerClients: number;
  maxTotalBufferedBytes: number;
};
type SerializedMessage = Buffer;
type HeadRange = { after: bigint; through: bigint };
type Block = {
  type: 'block';
  domain: number;
  height: string;
  hash: string;
  headHeight: string;
};
type BlockSubscription = {
  domains?: Set<number>;
  started: boolean;
  latest: Map<number, Block>;
};
export type EventDatabase = Pick<DbService, 'listen' | 'queryLive'>;

class HeadPublicationError extends Error {
  constructor(
    readonly original: unknown,
    readonly partialAgent: boolean,
    readonly explorerAffected: boolean,
  ) {
    super(`frontier publication failed: ${formatError(original)}`);
  }
}

export class EventWebSocketServer {
  private readonly logger = rootLogger.child({
    module: EventWebSocketServer.name,
  });
  private readonly clients = new Map<WebSocket, Client>();
  private readonly blockSubscriptions = new Map<WebSocket, BlockSubscription>();
  private readonly confirmationStreams = new Map<
    WebSocket,
    ConfirmationStream[]
  >();
  private readonly terminatedSockets = new WeakSet<WebSocket>();
  private readonly explorerClients = new Map<WebSocket, ExplorerClient>();
  private readonly explorerClientsByIp = new Map<string, number>();
  private readonly catchUpWaiters: CatchUpWaiter[] = [];
  private readonly explorerNotifications = new Set<string>();
  private readonly notifications = new Map<string, EventNotification>();
  private readonly headRanges = new Map<number, HeadRange>();
  private readonly headFailures = new Map<number, number>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerRetryTimer?: NodeJS.Timeout;
  private readonly agentNotifications = new NotificationWorker(
    NOTIFICATION_BATCH_MS,
    () => this.drainAgentNotifications(),
    (error) => this.failAgentStream(error),
  );
  private readonly explorerUpdates = new NotificationWorker(
    NOTIFICATION_BATCH_MS,
    () => this.drainExplorerNotifications(),
    (error) => this.failExplorerStream(error),
  );
  private readonly headUpdates = new NotificationWorker(
    NOTIFICATION_BATCH_MS,
    () => this.drainHeadNotifications(),
    (error) => {
      this.logger.error(`frontier publication failed: ${formatError(error)}`);
      this.headUpdates.schedule(LISTENER_RETRY_MS);
    },
  );
  private catchUps = 0;
  private pendingBytes = 0;
  private listenerReady = false;
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private httpServer?: Server;
  private agentServer?: WebSocketServer;
  private explorerServer?: WebSocketServer;
  private readonly limits: Limits;
  private readonly store: EventStore;

  constructor(
    private readonly db: EventDatabase,
    limits: Partial<Limits> = {},
  ) {
    this.store = new EventStore(db);
    this.limits = {
      heartbeatMs: HEARTBEAT_MS,
      maxAgentClients: config.EVENT_STREAM_MAX_AGENT_CLIENTS,
      maxBufferedBytes: config.EVENT_STREAM_MAX_BUFFERED_BYTES,
      maxCatchUpMs: config.EVENT_STREAM_HISTORY_MAX_MS,
      maxConcurrentCatchUps: config.EVENT_STREAM_HISTORY_MAX_CONCURRENT,
      maxExplorerClients: MAX_EXPLORER_CLIENTS,
      maxTotalBufferedBytes: config.EVENT_STREAM_MAX_TOTAL_BUFFERED_BYTES,
      ...limits,
    };
  }

  async start(server: Server): Promise<void> {
    const { heartbeatMs } = this.limits;
    if (
      typeof heartbeatMs !== 'number' ||
      !Number.isInteger(heartbeatMs) ||
      heartbeatMs < 1 ||
      heartbeatMs > MAX_INTERVAL_MS
    ) {
      throw new Error(
        `Invalid heartbeatMs ${String(heartbeatMs)}: must be an integer between 1 and ${MAX_INTERVAL_MS}`,
      );
    }
    await this.connectListener();
    this.agentServer = new WebSocketServer({
      // Agent subscriptions carry one cursor per chain and stream, so the
      // fleet-wide relayer payload is substantially larger than an Explorer
      // client request. Keep it bounded independently from outbound buffers.
      maxPayload: MAX_AGENT_MESSAGE_BYTES,
      noServer: true,
    });
    this.explorerServer = new WebSocketServer({
      maxPayload: 4_096,
      noServer: true,
    });
    this.httpServer = server;
    server.on('upgrade', this.handleUpgrade);
    this.agentServer.on('connection', (socket) => this.connectAgent(socket));
    this.explorerServer.on(
      'connection',
      (socket, request) =>
        void this.connectExplorer(socket, request).catch((error) =>
          this.failSocket(socket, formatError(error)),
        ),
    );
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.logger.info(
      `event websockets listening on ${AGENT_PATH}, ${MESSAGE_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE} maxAgentClients=${this.limits.maxAgentClients} maxBufferedBytes=${this.limits.maxBufferedBytes} maxTotalBufferedBytes=${this.limits.maxTotalBufferedBytes}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    [this.heartbeatTimer, this.listenerRetryTimer].forEach(
      (timer) => timer && clearTimeout(timer),
    );
    for (const worker of [
      this.agentNotifications,
      this.explorerUpdates,
      this.headUpdates,
    ])
      worker.stop();
    this.explorerNotifications.clear();
    this.notifications.clear();
    this.headRanges.clear();
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

  metricsSnapshot(): WebSocketMetricsSnapshot {
    const subscriptions: WebSocketMetricsSnapshot['subscriptions'] = {
      delivery: { catchingUp: 0, live: 0 },
      dispatch: { catchingUp: 0, live: 0 },
      gas_payment: { catchingUp: 0, live: 0 },
      merkle_tree_insertion: { catchingUp: 0, live: 0 },
    };
    const now = Date.now();
    let maxCatchUpDurationMs = 0;
    let maxCatchUpRows = 0;
    let maxPendingCatchUpEvents = 0;
    let pendingCatchUpEvents = 0;
    for (const client of this.clients.values()) {
      for (const [eventType, subscription] of client.subscriptions) {
        subscriptions[eventType][
          subscription.state === 'live' ? 'live' : 'catchingUp'
        ]++;
        pendingCatchUpEvents += subscription.pendingCount;
        maxPendingCatchUpEvents = Math.max(
          maxPendingCatchUpEvents,
          subscription.pendingCount,
        );
        if (subscription.state !== 'live') {
          maxCatchUpDurationMs = Math.max(
            maxCatchUpDurationMs,
            now - subscription.catchUpStartedAt,
          );
          maxCatchUpRows = Math.max(maxCatchUpRows, subscription.catchUpRows);
        }
      }
    }
    const sockets = [...this.clients.keys(), ...this.explorerClients.keys()];
    return {
      catchUps: this.catchUps,
      connections: {
        agent: this.clients.size,
        messages: this.explorerClients.size,
      },
      explorerPendingMessages: [...this.explorerClients.values()].reduce(
        (total, client) => total + client.queue.length,
        0,
      ),
      explorerPendingBytes: [...this.explorerClients.values()].reduce(
        (total, client) => total + client.queuedBytes,
        0,
      ),
      maxExplorerPendingBytes: Math.max(
        0,
        ...[...this.explorerClients.values()].map(
          (client) => client.queuedBytes,
        ),
      ),
      maxExplorerPendingMessages: Math.max(
        0,
        ...[...this.explorerClients.values()].map(
          (client) => client.queue.length,
        ),
      ),
      messageClientIps: this.explorerClientsByIp.size,
      messageMaxConnectionsPerIp: Math.max(
        0,
        ...this.explorerClientsByIp.values(),
      ),
      limits: {
        agentConnections: this.limits.maxAgentClients,
        catchUpMs: this.limits.maxCatchUpMs,
        clientMessagesPerMinute: MAX_CLIENT_MESSAGES,
        concurrentCatchUps: this.limits.maxConcurrentCatchUps,
        explorerPendingBytes: MAX_EXPLORER_PENDING_BYTES,
        explorerPendingMessages: MAX_EXPLORER_PENDING_MESSAGES,
        messageConnections: this.limits.maxExplorerClients,
        messageConnectionsPerIp: MAX_EXPLORER_CLIENTS_PER_IP,
        notificationEvents: MAX_PENDING_NOTIFICATIONS,
        pendingEvents: MAX_PENDING_EVENTS,
        socketBufferedBytes: this.limits.maxBufferedBytes,
        totalPendingBytes: this.limits.maxTotalBufferedBytes,
      },
      listenerReady: this.listenerReady,
      maxCatchUpDurationMs,
      maxCatchUpRows,
      maxClientBufferedBytes: sockets.reduce(
        (max, socket) => Math.max(max, socket.bufferedAmount),
        0,
      ),
      notificationQueue: {
        agent: this.notifications.size,
        messages: this.explorerNotifications.size,
      },
      outboundPendingBytes: this.pendingBytes,
      maxPendingCatchUpEvents,
      pendingCatchUpEvents,
      subscriptions,
    };
  }

  private connectAgent(socket: WebSocket): void {
    this.watch(socket);
    if (!this.accept(socket, 'agent')) return;
    this.clients.set(socket, {
      alive: true,
      messages: 0,
      messageWindow: Date.now(),
      subscriptions: new Map(),
      subscribing: false,
    });
    websocketConnections.inc({ route: 'agent' });
    this.send(socket, {
      confirmations: { unit: 'blocks', liveOnly: true },
      eventTypes: SUBSCRIPTION_TYPES,
      historicalStreaming: true,
      streamCursorVersions: STREAM_CURSOR_VERSIONS,
      type: 'ready',
    });
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
        : path === MESSAGE_PATH
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

  private async connectExplorer(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    this.watch(socket);
    if (!this.accept(socket, 'explorer')) return;
    let custom: ReturnType<typeof parseExplorerConfirmations>;
    let blocks: boolean;
    try {
      custom = parseExplorerConfirmations(request.url);
      blocks = parseExplorerBlocks(request.url);
    } catch (error) {
      this.rejectNegotiation(socket, formatError(error));
      return;
    }
    const ip = clientIp(request);
    if (!ip) {
      websocketConnectionRejections.inc({
        reason: 'invalid_client_ip',
        route: 'messages',
      });
      socket.close(1008, 'Missing or invalid client IP');
      return;
    }
    const connections = this.explorerClientsByIp.get(ip) ?? 0;
    if (connections >= MAX_EXPLORER_CLIENTS_PER_IP) {
      websocketConnectionRejections.inc({
        reason: 'per_ip_limit',
        route: 'messages',
      });
      socket.close(1008, 'Maximum connections per client reached');
      return;
    }
    this.explorerClientsByIp.set(ip, connections + 1);
    this.explorerClients.set(socket, {
      alive: true,
      custom: custom !== undefined,
      ip,
      queuedBytes: 0,
      queue: [],
      sending: false,
    });
    websocketConnections.inc({ route: 'messages' });
    let confirmationStream: ConfirmationStream | undefined;
    try {
      if (blocks) await this.subscribeBlocks(socket, custom?.domains);
      if (custom)
        confirmationStream = await this.createConfirmationStream(
          socket,
          custom.confirmations,
          custom.domains,
        );
    } catch (error) {
      if (!(error instanceof ConfirmationUnavailableError)) throw error;
      this.rejectNegotiation(socket, formatError(error));
      return;
    }
    this.send(socket, {
      ...(custom && {
        confirmations: custom.confirmations,
        domains: [...custom.domains],
        customDomains: confirmationStream?.customDomains,
        canonicalDomains: confirmationStream?.canonicalDomains,
      }),
      eventTypes: [
        'message_upsert',
        ...(custom ? ['rollback'] : []),
        ...(blocks ? ['block'] : []),
      ],
      type: 'ready',
    });
    confirmationStream?.start();
    this.startBlocks(socket);
  }

  private async subscribeBlocks(
    socket: WebSocket,
    domains?: Set<number>,
  ): Promise<void> {
    const subscription: BlockSubscription = {
      domains,
      started: false,
      latest: new Map(),
    };
    this.blockSubscriptions.set(socket, subscription);
    // Register before the snapshot: notifications received during the query win,
    // including lower heights and replacement hashes after a reorg.
    const rows = await this.store.blockHeads(domains);
    for (const row of rows) {
      const domain = parseDatabaseDomain(row.domain, 'Invalid block domain');
      const hash = parseOptionalBlockHash(row.hash);
      if (hash && !subscription.latest.has(domain))
        subscription.latest.set(domain, {
          type: 'block',
          domain,
          height: row.indexed_height,
          hash,
          headHeight: row.head_height,
        });
    }
  }

  private startBlocks(socket: WebSocket): void {
    const subscription = this.blockSubscriptions.get(socket);
    if (!subscription) return;
    subscription.started = true;
    for (const block of subscription.latest.values()) this.send(socket, block);
  }

  private publishBlock(block: Block): void {
    for (const [socket, subscription] of this.blockSubscriptions) {
      if (subscription.domains && !subscription.domains.has(block.domain))
        continue;
      const previous = subscription.latest.get(block.domain);
      if (
        previous?.height === block.height &&
        previous.hash === block.hash &&
        previous.headHeight === block.headHeight
      )
        continue;
      subscription.latest.set(block.domain, block);
      if (subscription.started) this.send(socket, block);
    }
  }

  private accept(socket: WebSocket, route: 'agent' | 'explorer'): boolean {
    const full =
      route === 'agent'
        ? this.clients.size >= this.limits.maxAgentClients
        : this.explorerClients.size >= this.limits.maxExplorerClients;
    if (!this.listenerReady || full) {
      websocketConnectionRejections.inc({
        reason: full ? 'connection_limit' : 'listener_unavailable',
        route: route === 'explorer' ? 'messages' : route,
      });
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

  private async createConfirmationStream(
    socket: WebSocket,
    confirmations: number,
    domains: Set<number>,
    eventType?: EventType,
  ): Promise<ConfirmationStream> {
    const stream = new ConfirmationStream(confirmations, domains, {
      active: () =>
        this.clients.has(socket) || this.explorerClients.has(socket),
      read: (domain, after, through, frontiers) =>
        eventType
          ? this.store.confirmationEventRows(
              eventType,
              domain,
              after,
              through,
              confirmations,
            )
          : this.store.confirmationMessageRows(
              domain,
              after,
              through,
              frontiers,
              confirmations,
            ),
      send: (message) => this.sendAndWait(socket, message),
      messageId: eventType
        ? undefined
        : (message) => {
            const data = message.data;
            if (
              typeof data !== 'object' ||
              data === null ||
              !('msg_id' in data)
            )
              return undefined;
            return typeof data.msg_id === 'string' ? data.msg_id : undefined;
          },
      enrich: eventType
        ? undefined
        : async (ids, frontiers) => {
            const rows = await this.store.provisionalMessages(ids, frontiers);
            return rows
              .filter(
                ({ data }) =>
                  domains.has(rowDomain(data, 'origin_domain_id')) ||
                  domains.has(rowDomain(data, 'destination_domain_id')),
              )
              .map(({ data, domains }) => ({
                domains,
                message: { type: 'message_upsert', confirmations, data },
              }));
          },
      rollback: (domain, from, to) => {
        this.send(socket, {
          type: 'rollback',
          domain,
          eventType,
          confirmations,
          fromHeight: from.toString(),
          toHeight: to.toString(),
        });
      },
      fail: (error) => this.failSocket(socket, formatError(error)),
    });
    const streams = this.confirmationStreams.get(socket) ?? [];
    streams.push(stream);
    this.confirmationStreams.set(socket, streams);
    await stream.initialize(
      () => this.store.confirmationHeads(domains),
      eventType === undefined,
    );
    return stream;
  }

  private watch(socket: WebSocket): void {
    socket.on('pong', () => {
      const client =
        this.clients.get(socket) ?? this.explorerClients.get(socket);
      if (client) client.alive = true;
    });
    socket.on('close', () => this.disconnect(socket));
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      this.disconnect(socket);
    });
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const client = this.clients.get(socket);
    if (!client) return;
    if (!consumeMessage(client)) {
      websocketClientMessageRejections.inc();
      this.sendError(socket, 'Client message rate limit exceeded');
      socket.close(1008, 'Client message rate limit exceeded');
      return;
    }

    let message;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      this.sendError(socket, formatError(error));
      return;
    }
    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    if (
      client.subscriptions.size ||
      client.subscribing ||
      this.blockSubscriptions.has(socket)
    ) {
      this.sendError(socket, 'Already subscribed');
      return;
    }

    if (
      message.streams.some(
        ({ eventType, confirmations }) =>
          eventType === 'delivery' && confirmations !== undefined,
      )
    ) {
      this.rejectNegotiation(
        socket,
        'Custom confirmations unavailable for delivery streams',
      );
      return;
    }
    client.subscribing = true;
    const eventStreams = message.streams.filter(
      (request) => request.eventType !== 'blocks',
    );
    try {
      const blocks = message.streams.find(
        (request) => request.eventType === 'blocks',
      );
      if (blocks) await this.subscribeBlocks(socket, blocks.domains);
      for (const request of eventStreams) {
        if (request.confirmations !== undefined && request.domains)
          await this.createConfirmationStream(
            socket,
            request.confirmations,
            request.domains,
            request.eventType,
          );
      }
    } catch (error) {
      if (error instanceof ConfirmationUnavailableError)
        this.rejectNegotiation(socket, formatError(error));
      else this.failSocket(socket, formatError(error));
      return;
    }
    if (this.clients.get(socket) !== client) return;
    for (const request of eventStreams) {
      const subscription = new AgentSubscription(
        request,
        this.store,
        this.limits.maxCatchUpMs,
        {
          active: () =>
            this.clients.get(socket) === client &&
            client.subscriptions.get(request.eventType) === subscription,
          send: (message) => this.sendAndWait(socket, message),
          close: (reason) => {
            socket.close(1013, reason);
          },
        },
      );
      client.subscriptions.set(request.eventType, subscription);
    }

    client.subscribing = false;
    this.send(socket, {
      streams: message.streams.map(subscriptionResponse),
      type: 'subscribed',
    });
    this.confirmationStreams.get(socket)?.forEach((stream) => stream.start());
    this.startBlocks(socket);
    await Promise.all(
      eventStreams
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
    if (!(await this.reserveCatchUp(socket))) return;
    try {
      websocketCatchUps.inc({ outcome: await subscription.replay() });
    } catch (error) {
      if (!subscription.isActive()) {
        websocketCatchUps.inc({ outcome: 'aborted' });
        return;
      }
      websocketCatchUps.inc({ outcome: 'failure' });
      client.subscriptions.delete(request.eventType);
      const reason = formatError(error);
      this.logger.warn(
        `websocket catch-up failed eventType=${request.eventType}: ${reason}`,
      );
      this.sendError(socket, `Failed to catch up ${request.eventType}`);
    } finally {
      this.releaseCatchUp();
    }
  }

  private reserveCatchUp(socket: WebSocket): Promise<boolean> {
    if (this.catchUps < this.limits.maxConcurrentCatchUps) {
      this.catchUps++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) =>
      this.catchUpWaiters.push({ resolve, socket }),
    );
  }

  private releaseCatchUp(): void {
    this.catchUps--;
    const waiter = this.catchUpWaiters.shift();
    if (!waiter) return;
    this.catchUps++;
    waiter.resolve(true);
  }

  private cancelCatchUp(socket: WebSocket): void {
    for (let index = this.catchUpWaiters.length - 1; index >= 0; index--) {
      if (this.catchUpWaiters[index]?.socket === socket) {
        this.catchUpWaiters.splice(index, 1)[0]?.resolve(false);
      }
    }
  }

  private publish(eventType: EventType, row: Row): void {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    const key = rowCursorKey(eventType, domain, row);
    let serialized: SerializedMessage | undefined;
    for (const [socket, client] of this.clients) {
      const subscription = client.subscriptions.get(eventType);
      if (!subscription?.matches(domain, key)) continue;
      if (subscription.state === 'live') {
        const message = subscription.eventForDelivery(row);
        if (!message) continue;
        // Gas payment envelopes include each subscriber's legacy cursor boundary.
        const payload =
          eventType === 'gas_payment'
            ? serialize(message)
            : (serialized ??= serialize(message));
        this.sendSerialized(socket, payload);
      } else if (!subscription.buffer(row)) {
        this.disconnect(socket);
        socket.close(1013, 'Event catch-up buffer exceeded');
      }
    }
  }

  private async connectListener(): Promise<void> {
    try {
      this.stopListening = await this.db.listen(
        [EVENT_CHANNEL, EXPLORER_CHANNEL, HEAD_CHANNEL],
        (channel, payload) => this.queueNotification(channel, payload),
        (error) => this.listenerDisconnected(error),
      );
      this.listenerReady = true;
    } catch (error) {
      this.logger.error(`database listener failed: ${formatError(error)}`);
      this.reconnectListener();
    }
  }

  private queueNotification(
    channel: string,
    payload: string | undefined,
  ): void {
    try {
      if (channel === HEAD_CHANNEL) {
        if (!this.clients.size && !this.explorerClients.size) return;
        const head = parseHeadNotification(payload);
        if (
          head.indexedHeight !== undefined &&
          head.indexedHash !== undefined &&
          head.headHeight !== undefined
        ) {
          this.publishBlock({
            type: 'block',
            domain: head.domain,
            height: head.indexedHeight.toString(),
            hash: head.indexedHash,
            headHeight: head.headHeight.toString(),
          });
        }
        this.store.invalidateMessages();
        for (const streams of this.confirmationStreams.values())
          for (const stream of streams) stream.notify(head);
        if (
          head.previousConfirmedHeight === undefined ||
          head.confirmedHeight <= head.previousConfirmedHeight
        )
          return;
        const current = this.headRanges.get(head.domain);
        this.headRanges.set(head.domain, {
          after:
            current && current.after < head.previousConfirmedHeight
              ? current.after
              : head.previousConfirmedHeight,
          through:
            current && current.through > head.confirmedHeight
              ? current.through
              : head.confirmedHeight,
        });
        this.headUpdates.schedule();
      } else if (channel === EXPLORER_CHANNEL) {
        const messageId = parseExplorerNotification(payload).messageId;
        this.queueExplorerNotification(messageId);
      } else {
        const notification = parseEventNotification(payload);
        if (!this.hasSubscriber(notification)) return;
        const key = `${notification.eventType}:${notification.id}`;
        if (
          !this.notifications.has(key) &&
          this.notifications.size >= MAX_PENDING_NOTIFICATIONS
        ) {
          websocketSendFailures.inc({
            reason: 'notification_queue_limit',
          });
          websocketNotificationQueueOverflows.inc({ route: 'agent' });
          this.failAgentStream(
            new Error('Agent notification queue limit exceeded'),
          );
          return;
        }
        this.notifications.set(key, notification);
        this.agentNotifications.schedule();
      }
    } catch (error) {
      this.logger.warn(
        `skipping invalid database notification: ${formatError(error)}`,
      );
      return;
    }
  }

  private queueExplorerNotification(messageId: string): void {
    if (!this.explorerClients.size) return;
    if (
      !this.explorerNotifications.has(messageId) &&
      this.explorerNotifications.size >= MAX_PENDING_NOTIFICATIONS
    ) {
      websocketSendFailures.inc({ reason: 'notification_queue_limit' });
      websocketNotificationQueueOverflows.inc({ route: 'messages' });
      this.failExplorerStream(
        new Error('Explorer notification queue limit exceeded'),
      );
      return;
    }
    this.explorerNotifications.add(messageId);
    this.explorerUpdates.schedule();
  }

  private async drainAgentNotifications(): Promise<void> {
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
  }

  private async drainHeadNotifications(): Promise<void> {
    try {
      for (const [domain, range] of this.headRanges) {
        try {
          await this.publishHeadRange(domain, range);
          this.headFailures.delete(domain);
        } catch (error) {
          const failure =
            error instanceof HeadPublicationError
              ? error
              : new HeadPublicationError(error, false, false);
          const failures = (this.headFailures.get(domain) ?? 0) + 1;
          this.headFailures.set(domain, failures);
          this.logger.error(
            `frontier publication failed for domain ${domain} (${failures}/${MAX_HEAD_PUBLICATION_FAILURES}): ${formatError(error)}`,
          );
          if (
            failure.partialAgent ||
            failures >= MAX_HEAD_PUBLICATION_FAILURES
          ) {
            this.failAgentDomain(domain, failure.original);
            if (failure.explorerAffected && this.explorerClients.size)
              this.failExplorerStream(failure.original);
            this.releaseHeadRange(domain, range);
            this.headFailures.delete(domain);
          }
          continue;
        }
        this.releaseHeadRange(domain, range);
      }
    } finally {
      if (this.headRanges.size)
        this.headUpdates.schedule(
          this.headFailures.size ? LISTENER_RETRY_MS : NOTIFICATION_BATCH_MS,
        );
    }
  }

  /** Drop a handled range, keeping any extension that arrived meanwhile. */
  private releaseHeadRange(domain: number, range: HeadRange): void {
    const current = this.headRanges.get(domain);
    if (!current) return;
    if (current.through <= range.through) {
      this.headRanges.delete(domain);
    } else {
      this.headRanges.set(domain, {
        after: range.through,
        through: current.through,
      });
    }
  }

  private async publishHeadRange(
    domain: number,
    { after, through }: HeadRange,
  ): Promise<void> {
    let agentPublished = false;
    let explorerPending = this.explorerClients.size > 0;
    // Delivery and gas share message ids; queue each Explorer id once per range.
    const explorerIds = new Set<string>();
    for (const eventType of HEAD_PUBLICATION_ORDER) {
      const agentInterested = this.hasSubscriber({
        domain,
        eventType,
        id: 0n,
      });
      const explorerInterested =
        this.explorerClients.size > 0 &&
        (eventType === 'delivery' || eventType === 'gas_payment');
      if (!agentInterested && !explorerInterested) continue;
      try {
        for await (const events of this.store.headEvents(
          eventType,
          domain,
          after,
          through,
        )) {
          if (this.stopped) return;
          if (agentInterested) {
            agentPublished = true;
            events.forEach((row) => this.publish(eventType, row));
          }
          if (explorerInterested && this.explorerClients.size) {
            const batch: string[] = [];
            events.forEach((row) => {
              const messageId = row.msg_id ?? row.message_id;
              if (
                typeof messageId === 'string' &&
                !explorerIds.has(messageId)
              ) {
                explorerIds.add(messageId);
                batch.push(messageId);
              }
            });
            // A range after an outage can hold more ids than the queue cap;
            // queue page by page and let the drain make room first.
            await this.waitForExplorerCapacity(batch.length);
            if (this.stopped) return;
            batch.forEach((messageId) =>
              this.queueExplorerNotification(messageId),
            );
          }
        }
      } catch (error) {
        throw new HeadPublicationError(error, agentPublished, explorerPending);
      }
      if (eventType === 'gas_payment') explorerPending = false;
    }
  }

  /** Wait until the Explorer queue can take `count` more ids without overflowing. */
  private async waitForExplorerCapacity(count: number): Promise<void> {
    const limit = MAX_PENDING_NOTIFICATIONS - count;
    while (
      !this.stopped &&
      this.explorerClients.size &&
      this.explorerNotifications.size > limit
    ) {
      await this.explorerUpdates.flush();
    }
  }

  private async drainExplorerNotifications(): Promise<void> {
    while (this.explorerNotifications.size) {
      const messageIds = [...this.explorerNotifications].slice(
        0,
        EXPLORER_NOTIFICATION_BATCH_SIZE,
      );
      messageIds.forEach((messageId) =>
        this.explorerNotifications.delete(messageId),
      );
      await this.publishExplorer(messageIds);
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
    const rows = await this.store.notifiedEvents(eventType, [
      ...expected.keys(),
    ]);
    const returned = new Set<string>();
    for (const { notification_id } of rows) {
      try {
        returned.add(parseId(notification_id).toString());
      } catch (error) {
        this.logger.warn(
          `invalid notified ${eventType} row ID: ${formatError(error)}`,
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
          `skipping invalid notified ${eventType} row: ${formatError(error)}`,
        );
        return [];
      }
    });
    events.sort((a, b) => compareRows(eventType, a, b));
    events.forEach((row) => this.publish(eventType, row));
  }

  private async publishExplorer(messageIds: string[]): Promise<void> {
    if (!this.explorerClients.size) return;
    this.store.invalidateMessages();
    for (const [socket, client] of this.explorerClients) {
      if (client.custom)
        this.confirmationStreams
          .get(socket)
          ?.forEach((stream) => stream.refresh(messageIds));
    }
    if (![...this.explorerClients.values()].some((client) => !client.custom))
      return;
    const rows = await this.store.canonicalMessages(messageIds);
    const messages = rows.map((row) =>
      serialize({ data: row, type: 'message_upsert' }),
    );
    for (const [socket, client] of this.explorerClients) {
      if (client.custom) continue;
      this.enqueueExplorer(socket, client, messages);
    }
  }

  private enqueueExplorer(
    socket: WebSocket,
    client: ExplorerClient,
    messages: SerializedMessage[],
  ): void {
    const bytes = messages.reduce(
      (total, message) => total + message.length,
      0,
    );
    if (
      client.queue.length + messages.length > MAX_EXPLORER_PENDING_MESSAGES ||
      client.queuedBytes + bytes > MAX_EXPLORER_PENDING_BYTES
    ) {
      websocketSendFailures.inc({ reason: 'queue_limit' });
      this.failSocket(socket, 'outbound message queue limit exceeded');
      return;
    }
    client.queue.push(...messages);
    client.queuedBytes += bytes;
    if (!client.sending) void this.drainExplorerClient(socket, client);
  }

  private async drainExplorerClient(
    socket: WebSocket,
    client: ExplorerClient,
  ): Promise<void> {
    client.sending = true;
    try {
      while (this.explorerClients.get(socket) === client) {
        const message = client.queue.shift();
        if (!message) return;
        client.queuedBytes = Math.max(0, client.queuedBytes - message.length);
        if (!(await this.sendSerializedAndWait(socket, message))) return;
      }
    } finally {
      client.sending = false;
    }
  }

  private hasSubscriber({ domain, eventType }: EventNotification): boolean {
    for (const client of this.clients.values()) {
      const subscription = client.subscriptions.get(eventType);
      if (
        subscription &&
        subscription.request.confirmations === undefined &&
        subscription.matchesDomain(domain)
      )
        return true;
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

  private failAgentStream(error: unknown): void {
    this.logger.error(`agent event stream failed: ${formatError(error)}`);
    this.closeAgentClients('Event stream read failed');
  }

  private failAgentDomain(domain: number, error: unknown): void {
    this.logger.error(
      `agent event stream failed for domain ${domain}: ${formatError(error)}`,
    );
    for (const [socket, client] of this.clients) {
      if (
        [...client.subscriptions.values()].some((subscription) =>
          subscription.matchesDomain(domain),
        )
      ) {
        this.disconnect(socket);
        socket.close(1013, 'Event stream read failed');
      }
    }
  }

  private failExplorerStream(error: unknown): void {
    this.logger.error(`Explorer event stream failed: ${formatError(error)}`);
    this.closeExplorerClients('Event stream read failed');
  }

  private closeClients(reason: string, code = 1013): void {
    this.confirmationStreams.clear();
    this.store.invalidateMessages();
    this.closeAgentClients(reason, code);
    this.closeExplorerClients(reason, code);
  }

  private closeAgentClients(reason: string, code = 1013): void {
    this.notifications.clear();
    this.headRanges.clear();
    this.headFailures.clear();
    for (const socket of this.clients.keys()) {
      this.disconnect(socket);
      socket.close(code, reason);
    }
    this.clients.clear();
  }

  private closeExplorerClients(reason: string, code = 1013): void {
    this.explorerNotifications.clear();
    for (const socket of this.explorerClients.keys()) {
      this.disconnect(socket);
      socket.close(code, reason);
    }
    this.explorerClients.clear();
    this.explorerClientsByIp.clear();
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
        this.terminateSocket(socket);
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

  private sendAndWait(
    socket: WebSocket,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    return this.sendSerializedAndWait(socket, serialize(message));
  }

  private sendSerializedAndWait(
    socket: WebSocket,
    message: SerializedMessage,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.sendSerialized(socket, message, resolve)) {
        resolve(false);
      }
    });
  }

  private sendSerialized(
    socket: WebSocket,
    message: SerializedMessage,
    completed?: (sent: boolean) => void,
  ): boolean {
    if (
      this.terminatedSockets.has(socket) ||
      socket.readyState !== WebSocket.OPEN
    )
      return false;
    if (
      socket.bufferedAmount + message.length > this.limits.maxBufferedBytes ||
      this.pendingBytes + message.length > this.limits.maxTotalBufferedBytes
    ) {
      websocketSendFailures.inc({ reason: 'buffer_limit' });
      this.failSocket(socket, 'outbound buffer limit exceeded');
      return false;
    }
    this.pendingBytes += message.length;
    try {
      socket.send(message, { binary: false }, (error) => {
        this.pendingBytes = Math.max(0, this.pendingBytes - message.length);
        completed?.(!error);
        if (error) this.failSend(socket, error.message);
      });
    } catch (error) {
      this.pendingBytes = Math.max(0, this.pendingBytes - message.length);
      completed?.(false);
      this.failSend(socket, formatError(error));
      return false;
    }
    return true;
  }

  private failSocket(socket: WebSocket, reason: string): void {
    if (this.terminatedSockets.has(socket)) return;
    this.logger.warn(`terminating websocket: ${reason}`);
    this.terminateSocket(socket);
  }

  private failSend(socket: WebSocket, reason: string): void {
    if (this.terminatedSockets.has(socket)) return;
    websocketSendFailures.inc({ reason: 'send_error' });
    this.failSocket(socket, `send failed: ${reason}`);
  }

  private terminateSocket(socket: WebSocket): void {
    if (this.terminatedSockets.has(socket)) return;
    this.terminatedSockets.add(socket);
    this.disconnect(socket);
    socket.terminate();
  }

  private disconnect(socket: WebSocket): void {
    this.blockSubscriptions.delete(socket);
    this.confirmationStreams.delete(socket);
    this.cancelCatchUp(socket);
    this.clients.get(socket)?.subscriptions.clear();
    this.clients.delete(socket);
    const explorerClient = this.explorerClients.get(socket);
    if (explorerClient) {
      this.clearExplorerQueue(explorerClient);
      this.releaseExplorerClient(explorerClient.ip);
    }
    this.explorerClients.delete(socket);
  }

  private clearExplorerQueue(client: ExplorerClient): void {
    client.queue.length = 0;
    client.queuedBytes = 0;
  }

  private releaseExplorerClient(ip: string): void {
    const connections = this.explorerClientsByIp.get(ip);
    if (!connections) return;
    if (connections === 1) this.explorerClientsByIp.delete(ip);
    else this.explorerClientsByIp.set(ip, connections - 1);
  }

  private rejectNegotiation(socket: WebSocket, error: string): void {
    this.sendError(socket, error);
    this.disconnect(socket);
    socket.close(1008, 'Invalid subscription');
  }

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
}

function serialize(message: Record<string, unknown>): SerializedMessage {
  // Explorer broadcasts share this payload; encode UTF-8 once for every recipient.
  return Buffer.from(JSON.stringify(message));
}

function subscriptionResponse(
  request: StreamRequest | BlockStreamRequest,
): Record<string, unknown> {
  return {
    confirmations: request.confirmations,
    cursors: request.cursors?.map((cursor) =>
      cursor.kind === 'gas_payment'
        ? {
            address: displayAddress(cursor.address),
            afterStreamCursor: cursor.afterStreamCursor?.toString(),
            domain: cursor.domain,
          }
        : {
            address: displayAddress(cursor.address),
            afterSequence: cursor.afterSequence?.toString(),
            domain: cursor.domain,
          },
    ),
    domains: request.domains ? [...request.domains] : undefined,
    eventType: request.eventType,
    streamCursorVersion: request.streamCursorVersion,
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

function clientIp(request: IncomingMessage): string | undefined {
  const cloudflareIp = request.headers['cf-connecting-ip'];
  if (cloudflareIp !== undefined) {
    return typeof cloudflareIp === 'string' && isIP(cloudflareIp)
      ? cloudflareIp
      : undefined;
  }
  if (process.env.NODE_ENV === 'production') return undefined;
  const remoteIp = request.socket.remoteAddress;
  if (!remoteIp) return undefined;
  const ipv4 = remoteIp.startsWith('::ffff:') ? remoteIp.slice(7) : remoteIp;
  return isIP(ipv4) ? ipv4 : undefined;
}
