import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { rootLogger } from '@hyperlane-xyz/utils';
import { formatError } from '@hyperlane-xyz/utils/errors';
import { WebSocket, WebSocketServer } from 'ws';

import { DiagnosticsStream } from '../diagnostics/stream.js';
import type { DiagnosticsService } from '../diagnostics/service.js';
import {
  DiagnosticsEventType,
  type DiagnosticsFrame,
} from '../diagnostics/types.js';
import { config } from '../config.js';
import type { DbService } from '../db/db.service.js';
import {
  type WebSocketMetricsSnapshot,
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
  type HeadNotification,
  type LiveStartBoundary,
  parseClientMessage,
  SubscriptionCapacityError,
  splitConfirmationStreams,
  parseEventNotification,
  parseExplorerNotification,
  parseExplorerConfirmations,
  parseExplorerBlocks,
  parseExplorerMessageIds,
  parseExplorerDiagnostics,
  parseValidatorSubscription,
  parseValidatorPing,
  parseHeadNotification,
  parseId,
  type StreamRequest,
  type ClientMessage,
  ConfirmationUnavailableError,
} from './protocol.js';
import { EventSource } from './event-source.js';
import {
  type Row,
  STREAMS,
  compareRows,
  eventMessage,
  rowDomain,
  EventStore,
} from './event-store.js';
import { MessageSource } from './message-source.js';
import { rawData } from './websocket-data.js';
import { NotificationWorker } from './notification-worker.js';
import { validatorClientIp } from './validator-client.js';
import { BroadcastQueue } from './broadcast-queue.js';

// Explorer types first: a failure in an agent-only type must not close Explorer
// clients that already received this range. No cross-type order is promised.
const HEAD_PUBLICATION_ORDER = [
  'delivery',
  'gas_payment',
  'dispatch',
  'merkle_tree_insertion',
] as const satisfies readonly EventType[];

const AGENT_PATH = '/agents';
const MAX_AGENT_MESSAGE_BYTES = 65_536;
const MESSAGE_PATH = '/messages';
const VALIDATOR_PATH = '/validators';
const MAX_VALIDATOR_MESSAGE_BYTES = 1_024;
const MAX_VALIDATOR_CLIENTS = 2_000;
const MAX_VALIDATOR_CLIENTS_PER_IP = 100;
const MAX_VALIDATOR_PENDING_SETUPS = 32;
const MAX_VALIDATOR_PENDING_SETUPS_PER_IP = 8;
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
const MAX_EXPLORER_CLIENTS = 500;
const MAX_EXPLORER_CLIENTS_PER_IP = 5;
const MAX_EXPLORER_PENDING_SETUPS = 32;
const MAX_EXPLORER_PENDING_SETUPS_PER_IP = 2;
const MAX_EXPLORER_SUBSCRIPTION_BYTES = 8_192;
const MAX_EXPLORER_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_EXPLORER_TOTAL_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_EXPLORER_PENDING_MESSAGES = 2_000;
// Each refresh reads at most a few fact batches; this keeps a notification
// backlog well inside the shared read queue.
const MAX_EXPLORER_REFRESHES = 4;
const MAX_CLIENT_MESSAGES = 30;
const MAX_PENDING_NOTIFICATIONS = 10_000;
const MAX_HEAD_PUBLICATION_FAILURES = 3;
const FANOUT_BYTES_PER_TURN = 256 * 1024;
const FANOUT_MESSAGES_PER_TURN = 64;
const VALIDATOR_SOURCE_LIMITS = {
  rows: 10_000,
  bytes: 8 * 1024 * 1024,
  parallel: 2,
  ranges: 512,
};
type Route = 'agent' | 'validators' | 'messages';
type Client = {
  alive: boolean;
  messages: number;
  messageWindow: number;
  subscriptions: Map<EventType, StreamRequest>;
  subscribing: boolean;
  events?: Awaited<ReturnType<EventSource['subscribe']>>;
};
type ValidatorClient = {
  ip: string;
  pending: boolean;
};
type ExplorerClient = {
  domains?: Set<number>;
  ready: boolean;
  messageIds?: Set<string>;
  alive: boolean;
  custom: boolean;
  unsubscribe?: () => void;
  ip: string;
};
type Limits = {
  heartbeatMs: number;
  maxAgentClients: number;
  maxBufferedBytes: number;
  maxExplorerClients: number;
  maxValidatorClients: number;
  maxValidatorClientsPerIp: number;
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
export type EventDatabase = Pick<
  DbService,
  'listen' | 'queryLive' | 'queryValidator'
>;

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
  private readonly validatorClients = new Map<WebSocket, ValidatorClient>();
  private readonly blockSubscriptions = new Map<WebSocket, BlockSubscription>();
  private readonly terminatedSockets = new WeakSet<WebSocket>();
  private readonly explorerClients = new Map<WebSocket, ExplorerClient>();
  private readonly explorerClientsByIp = new Map<string, number>();
  private readonly explorerPendingSetups = new Map<WebSocket, string>();
  private readonly explorerPendingSetupsByIp = new Map<string, number>();
  private readonly explorerNotifications = new Set<string>();
  private readonly notifications = new Map<string, EventNotification>();
  private readonly validatorNotifications = new Map<
    string,
    EventNotification
  >();
  private readonly validatorHeadRanges = new Map<number, HeadRange>();
  private readonly pendingHeads = new Map<number, HeadNotification>();
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
  private readonly validatorUpdates = new NotificationWorker(
    NOTIFICATION_BATCH_MS,
    () => this.drainValidatorUpdates(),
    (error) => this.failValidatorStream(error),
  );
  private readonly confirmationUpdates = new NotificationWorker(
    NOTIFICATION_BATCH_MS,
    async () => {
      const heads = [...this.pendingHeads.values()];
      this.pendingHeads.clear();
      if (!heads.length) return;
      for (const head of heads) this.notifySources(head);
    },
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
  private pendingBytes = 0;
  private readonly explorerQueue = this.createBroadcastQueue();
  private readonly eventQueue = this.createBroadcastQueue(16 * 1024 * 1024);
  private readonly validatorQueue = this.createBroadcastQueue(8 * 1024 * 1024);
  private readonly routes = new WeakMap<WebSocket, Route>();
  private readonly pendingSends = new Map<
    WebSocket,
    { route: Route; bytes: number }
  >();
  private readonly routePending: Record<Route, number> = {
    agent: 0,
    validators: 0,
    messages: 0,
  };
  private readonly explorerRefreshes = new Set<Promise<void>>();
  private listenerReady = false;
  private stopped = false;
  private stopListening?: () => Promise<void>;
  private httpServer?: Server;
  private agentServer?: WebSocketServer;
  private explorerServer?: WebSocketServer;
  private validatorServer?: WebSocketServer;
  private readonly limits: Limits;
  private readonly store: EventStore;
  private messageSource: MessageSource;
  private eventSource: EventSource;
  private validatorSource: EventSource;
  private readonly validatorStore: EventStore;
  private readonly diagnostics?: DiagnosticsStream;
  // Frames shared by many sockets (message upserts, blocks, diagnostics) are
  // encoded once.
  private readonly serializedFrames = new WeakMap<object, SerializedMessage>();

  constructor(
    private readonly db: EventDatabase,
    limits: Partial<Limits> = {},
    diagnostics?: DiagnosticsService,
  ) {
    if (diagnostics) this.diagnostics = new DiagnosticsStream(diagnostics);
    this.store = new EventStore(db);
    this.messageSource = new MessageSource(this.store);
    this.validatorStore = new EventStore({
      queryLive: (text, values) => db.queryValidator(text, values),
    });
    this.eventSource = new EventSource(this.store);
    this.validatorSource = new EventSource(
      this.validatorStore,
      VALIDATOR_SOURCE_LIMITS,
    );
    this.limits = {
      heartbeatMs: HEARTBEAT_MS,
      maxAgentClients: config.EVENT_STREAM_MAX_AGENT_CLIENTS,
      maxBufferedBytes: config.EVENT_STREAM_MAX_BUFFERED_BYTES,
      maxExplorerClients: MAX_EXPLORER_CLIENTS,
      maxValidatorClients: MAX_VALIDATOR_CLIENTS,
      maxValidatorClientsPerIp: MAX_VALIDATOR_CLIENTS_PER_IP,
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
    this.diagnostics?.start();
    this.agentServer = new WebSocketServer({
      // Bound fleet-wide domain lists independently from outbound buffers.
      maxPayload: MAX_AGENT_MESSAGE_BYTES,
      noServer: true,
    });
    this.explorerServer = new WebSocketServer({
      maxPayload: 4_096,
      noServer: true,
    });
    this.validatorServer = new WebSocketServer({
      maxPayload: MAX_VALIDATOR_MESSAGE_BYTES,
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
      `event websockets listening on ${AGENT_PATH}, ${MESSAGE_PATH}, ${VALIDATOR_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE} maxAgentClients=${this.limits.maxAgentClients} maxValidatorClients=${this.limits.maxValidatorClients} maxBufferedBytes=${this.limits.maxBufferedBytes} maxTotalBufferedBytes=${this.limits.maxTotalBufferedBytes}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.diagnostics?.stop();
    [this.heartbeatTimer, this.listenerRetryTimer].forEach(
      (timer) => timer && clearTimeout(timer),
    );
    for (const worker of [
      this.agentNotifications,
      this.validatorUpdates,
      this.explorerUpdates,
      this.headUpdates,
      this.confirmationUpdates,
    ])
      worker.stop();
    this.explorerNotifications.clear();
    this.notifications.clear();
    this.headRanges.clear();
    await this.stopListening?.();
    this.httpServer?.off('upgrade', this.handleUpgrade);
    this.closeClients('Server stopping', 1001);
    await Promise.all(
      [this.agentServer, this.explorerServer, this.validatorServer].map(
        (websocketServer) =>
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
    const explorerQueue = this.explorerQueue.metrics();
    const subscriptions: WebSocketMetricsSnapshot['subscriptions'] = {
      delivery: 0,
      dispatch: 0,
      gas_payment: 0,
      merkle_tree_insertion: 0,
    };
    const validatorSubscriptions = new Map<
      number,
      { domain: number; canonical: number; custom: number }
    >();
    for (const [socket, client] of this.clients) {
      if (this.validatorClients.has(socket)) {
        for (const request of client.subscriptions.values()) {
          for (const domain of request.domains ?? []) {
            const counts = validatorSubscriptions.get(domain) ?? {
              domain,
              canonical: 0,
              custom: 0,
            };
            counts[
              request.confirmations === undefined ? 'canonical' : 'custom'
            ]++;
            validatorSubscriptions.set(domain, counts);
          }
        }
        continue;
      }
      for (const eventType of client.subscriptions.keys())
        subscriptions[eventType]++;
    }
    const sockets = [...this.clients.keys(), ...this.explorerClients.keys()];
    const validatorIps = new Map<string, number>();
    for (const { ip } of this.validatorClients.values())
      validatorIps.set(ip, (validatorIps.get(ip) ?? 0) + 1);
    const validatorConnections = this.validatorCount();
    return {
      connections: {
        agent: this.clients.size - validatorConnections,
        messages: this.explorerClients.size,
        validators: validatorConnections,
      },
      validatorPendingSetups: [...this.validatorClients.values()].filter(
        (client) => client.pending,
      ).length,
      explorerPendingSetups: this.explorerPendingSetups.size,
      messageSource: this.messageSource.metrics(),
      eventSource: this.eventSource.metrics(),
      validatorSource: this.validatorSource.metrics(),
      queues: {
        agent: this.eventQueue.metrics(),
        validators: this.validatorQueue.metrics(),
        messages: explorerQueue,
      },
      validatorReservedConnections: this.validatorClients.size,
      validatorSharedReaders: this.validatorSource.metrics().ranges,
      validatorSubscriptions: [...validatorSubscriptions.values()],
      validatorClientIps: validatorIps.size,
      validatorMaxConnectionsPerIp: Math.max(0, ...validatorIps.values()),
      explorerPendingMessages: explorerQueue.messages,
      explorerPendingBytes: explorerQueue.bytes,
      maxExplorerPendingBytes: explorerQueue.maxBytes,
      maxExplorerPendingMessages: explorerQueue.maxMessages,
      messageClientIps: this.explorerClientsByIp.size,
      messageMaxConnectionsPerIp: Math.max(
        0,
        ...this.explorerClientsByIp.values(),
      ),
      limits: {
        agentConnections: this.limits.maxAgentClients,
        clientMessagesPerMinute: MAX_CLIENT_MESSAGES,
        explorerPendingBytes: MAX_EXPLORER_PENDING_BYTES,
        explorerPendingMessages: MAX_EXPLORER_PENDING_MESSAGES,
        messageConnections: this.limits.maxExplorerClients,
        messageConnectionsPerIp: MAX_EXPLORER_CLIENTS_PER_IP,
        messageSetups: MAX_EXPLORER_PENDING_SETUPS,
        messageSetupsPerIp: MAX_EXPLORER_PENDING_SETUPS_PER_IP,
        validatorConnections: this.limits.maxValidatorClients,
        validatorSetups: MAX_VALIDATOR_PENDING_SETUPS,
        validatorConnectionsPerIp: this.limits.maxValidatorClientsPerIp,
        validatorMessageBytes: MAX_VALIDATOR_MESSAGE_BYTES,
        notificationEvents: MAX_PENDING_NOTIFICATIONS,
        socketBufferedBytes: this.limits.maxBufferedBytes,
        totalPendingBytes: this.limits.maxTotalBufferedBytes,
      },
      listenerReady: this.listenerReady,
      maxClientBufferedBytes: sockets.reduce(
        (max, socket) => Math.max(max, socket.bufferedAmount),
        0,
      ),
      notificationQueue: {
        agent: this.notifications.size,
        messages: this.explorerNotifications.size,
        validators: this.validatorNotifications.size,
      },
      outboundPendingBytes: this.pendingBytes,
      subscriptions,
    };
  }

  private connectAgent(socket: WebSocket): void {
    this.watch(socket, 'agent');
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
      confirmations: { unit: 'blocks', liveOnly: true, byDomain: true },
      eventTypes: SUBSCRIPTION_TYPES,
      historicalStreaming: false,
      liveStartVersion: 1,
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
          : path === VALIDATOR_PATH
            ? this.validatorServer
            : undefined;
    if (!websocketServer) {
      socket.destroy();
      return;
    }
    let admission:
      | {
          client: ValidatorClient;
          subscription: ReturnType<typeof parseValidatorSubscription>;
        }
      | undefined;
    if (path === VALIDATOR_PATH) {
      let status = 400;
      let reason = 'invalid_subscription';
      try {
        if (Buffer.byteLength(request.url ?? '') > MAX_VALIDATOR_MESSAGE_BYTES)
          throw new Error('Validator subscription URL too long');
        const subscription = parseValidatorSubscription(
          new URL(request.url ?? '/', 'http://localhost').searchParams,
        );
        status = 403;
        reason = 'invalid_client_ip';
        const client = { ip: validatorClientIp(request), pending: true };
        status = 503;
        reason = 'listener_unavailable';
        if (!this.listenerReady)
          throw new Error('Database event listener unavailable');
        reason = 'connection_limit';
        const clients = [...this.validatorClients.values()];
        if (clients.length >= this.limits.maxValidatorClients)
          throw new Error('Maximum validator clients reached');
        reason = 'setup_limit';
        if (
          clients.filter((entry) => entry.pending).length >=
          MAX_VALIDATOR_PENDING_SETUPS
        )
          throw new Error('Maximum validator setups reached');
        status = 429;
        reason = 'per_ip_setup_limit';
        const peers = clients.filter((entry) => entry.ip === client.ip);
        if (
          peers.filter((entry) => entry.pending).length >=
          MAX_VALIDATOR_PENDING_SETUPS_PER_IP
        )
          throw new Error('Maximum setups per client reached');
        reason = 'per_ip_limit';
        if (peers.length >= this.limits.maxValidatorClientsPerIp)
          throw new Error('Maximum connections per client reached');
        admission = { client, subscription };
      } catch {
        websocketConnectionRejections.inc({ route: 'validators', reason });
        socket.end(
          `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          () => socket.destroy(),
        );
        return;
      }
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (admission)
        void this.connectValidator(
          websocket,
          admission.client,
          admission.subscription,
        ).catch((error) => this.failSocket(websocket, formatError(error)));
      else websocketServer.emit('connection', websocket, request);
    });
  };

  private async connectValidator(
    socket: WebSocket,
    validator: ValidatorClient,
    subscription: ReturnType<typeof parseValidatorSubscription>,
  ): Promise<void> {
    this.watch(socket, 'validators');
    const client: Client = {
      alive: true,
      messages: 0,
      messageWindow: Date.now(),
      subscriptions: new Map(),
      subscribing: true,
    };
    this.clients.set(socket, client);
    this.validatorClients.set(socket, validator);
    websocketConnections.inc({ route: 'validators' });
    socket.on('message', (data, binary) => {
      if (this.clients.get(socket) !== client) return;
      let reason = 'invalid_message';
      try {
        if (!consumeMessage(client)) {
          reason = 'message_rate_limit';
          websocketClientMessageRejections.inc();
          throw new Error('Client message rate limit exceeded');
        }
        if (binary) throw new Error('Expected a text ping');
        parseValidatorPing(rawData(data));
        this.send(socket, { type: 'pong' });
      } catch (error) {
        this.rejectNegotiation(socket, formatError(error), reason);
      }
    });
    // Disconnected negotiations retain their work slot until the DB read ends.
    try {
      const { domain, confirmations } = subscription;
      const exists = await this.validatorStore.domainExists(domain);
      if (this.clients.get(socket) !== client) return;
      if (!exists) {
        this.rejectNegotiation(socket, `Unknown domain ${domain}`);
        return;
      }
      await this.subscribeClient(
        socket,
        client,
        {
          type: 'subscribe',
          streams: [
            {
              eventType: 'merkle_tree_insertion',
              domains: new Set([domain]),
              confirmations,
            },
          ],
        },
        {
          type: 'ready',
          domain,
          confirmations,
          eventTypes: ['merkle_tree_insertion'],
          historicalStreaming: false,
          liveStartVersion: 1,
        },
      );
    } catch (error) {
      this.rejectNegotiation(
        socket,
        formatError(error),
        error instanceof ConfirmationUnavailableError
          ? 'invalid_subscription'
          : 'setup_error',
        error instanceof ConfirmationUnavailableError ? 1008 : 1013,
      );
    } finally {
      validator.pending = false;
      if (!this.clients.has(socket)) this.releaseValidator(socket);
    }
  }

  private validatorCount(): number {
    return [...this.validatorClients.keys()].filter((socket) =>
      this.clients.has(socket),
    ).length;
  }

  private async connectExplorer(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    this.watch(socket, 'messages');
    if (!this.accept(socket, 'explorer')) return;
    let custom: ReturnType<typeof parseExplorerConfirmations>;
    let blocks: boolean;
    let diagnostics: boolean;
    let messageIds: Set<string> | undefined;
    try {
      if (
        Buffer.byteLength(request.url ?? '') > MAX_EXPLORER_SUBSCRIPTION_BYTES
      )
        throw new Error('Explorer subscription URL too long');
      const params = new URL(request.url ?? '/', 'http://localhost')
        .searchParams;
      custom = parseExplorerConfirmations(params);
      blocks = parseExplorerBlocks(params);
      messageIds = parseExplorerMessageIds(params);
      diagnostics = parseExplorerDiagnostics(params, messageIds);
    } catch (error) {
      this.rejectNegotiation(socket, formatError(error));
      return;
    }
    let ip: string;
    try {
      ip = validatorClientIp(request);
    } catch {
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
    if (this.explorerPendingSetups.size >= MAX_EXPLORER_PENDING_SETUPS) {
      websocketConnectionRejections.inc({
        reason: 'setup_limit',
        route: 'messages',
      });
      socket.close(1013, 'Maximum message setups reached');
      return;
    }
    const pendingForIp = this.explorerPendingSetupsByIp.get(ip) ?? 0;
    if (pendingForIp >= MAX_EXPLORER_PENDING_SETUPS_PER_IP) {
      websocketConnectionRejections.inc({
        reason: 'per_ip_setup_limit',
        route: 'messages',
      });
      socket.close(1008, 'Maximum setups per client reached');
      return;
    }
    this.explorerPendingSetups.set(socket, ip);
    this.explorerPendingSetupsByIp.set(ip, pendingForIp + 1);
    this.explorerClientsByIp.set(ip, connections + 1);
    this.explorerClients.set(socket, {
      domains: custom?.domains,
      ready: false,
      alive: true,
      custom: custom !== undefined,
      messageIds,
      ip,
    });
    websocketConnections.inc({ route: 'messages' });
    socket.on('message', () => {
      if (!this.explorerClients.has(socket)) return;
      websocketClientMessageRejections.inc();
      this.rejectNegotiation(socket, 'Client messages are unsupported');
    });
    try {
      if (blocks) await this.subscribeBlocks(socket, custom?.domains);
      if (custom) await this.messageSource.currentHeads();
    } finally {
      this.releaseExplorerSetup(socket);
    }
    // Initialization awaits DB reads; the peer may already have disconnected.
    const client = this.explorerClients.get(socket);
    if (!client || socket.readyState !== WebSocket.OPEN) return;
    const subscription =
      custom &&
      this.messageSource.subscribe(
        custom,
        messageIds,
        (frame) =>
          this.explorerQueue.enqueue(socket, [this.serializeShared(frame)]),
        (error) => this.failSocket(socket, formatError(error)),
      );
    client.unsubscribe = subscription?.unsubscribe;
    client.ready = true;
    this.send(socket, {
      ...(messageIds && { messageIds: [...messageIds] }),
      ...(custom && {
        confirmations: custom.confirmations,
        domains: [...custom.domains],
        customDomains: subscription?.customDomains,
        canonicalDomains: subscription?.canonicalDomains,
      }),
      eventTypes: [
        'message_upsert',
        ...(custom ? ['rollback'] : []),
        ...(blocks ? ['block'] : []),
        ...(diagnostics ? Object.values(DiagnosticsEventType) : []),
      ],
      type: 'ready',
    });
    this.startBlocks(socket);
    if (diagnostics && messageIds) {
      try {
        if (!this.diagnostics)
          throw new Error('Diagnostics are not configured');
        const unsubscribe = this.diagnostics.subscribe(
          ip,
          [...messageIds].map(displayAddress),
          (frame, complete) => this.sendDiagnostics(socket, frame, complete),
        );
        socket.once('close', unsubscribe);
      } catch (error) {
        this.sendDiagnostics(socket, {
          type: DiagnosticsEventType.Unavailable,
          message_ids: [...messageIds].map(displayAddress),
          message: formatError(error),
        });
      }
    }
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
    const heads = await (this.explorerClients.has(socket)
      ? this.messageSource.currentHeads()
      : this.store.messageHeads(domains));
    for (const [domain, head] of heads) {
      if (
        head.hash &&
        (!domains || domains.has(domain)) &&
        !subscription.latest.has(domain)
      )
        subscription.latest.set(domain, {
          type: 'block',
          domain,
          height: String(head.indexed),
          headHeight: String(head.head),
          hash: head.hash,
        });
    }
  }

  private startBlocks(socket: WebSocket): void {
    const subscription = this.blockSubscriptions.get(socket);
    if (!subscription) return;
    subscription.started = true;
    for (const block of subscription.latest.values())
      this.queueData(socket, this.serializeShared(block));
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
      if (subscription.started)
        this.queueData(socket, this.serializeShared(block));
    }
  }

  private accept(socket: WebSocket, route: 'agent' | 'explorer'): boolean {
    const full =
      route === 'agent'
        ? this.clients.size - this.validatorCount() >=
          this.limits.maxAgentClients
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

  private async subscribeEvents(
    socket: WebSocket,
    client: Client,
    requests: Parameters<EventSource['subscribe']>[0],
  ): Promise<void> {
    await this.confirmationUpdates.flush();
    if (this.clients.get(socket) !== client) return;
    const source = this.validatorClients.has(socket)
      ? this.validatorSource
      : this.eventSource;
    const events = await source.subscribe(requests, {
      active: () => this.clients.get(socket) === client,
      send: (message) => {
        return this.queueData(socket, this.serializeShared(message));
      },
      fail: (error) => this.failSocket(socket, formatError(error)),
    });
    if (this.clients.get(socket) === client) client.events = events;
    else events.stop();
  }

  private watch(socket: WebSocket, route: Route): void {
    this.routes.set(socket, route);
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
      if (error instanceof SubscriptionCapacityError)
        this.rejectNegotiation(socket, formatError(error));
      else this.sendError(socket, formatError(error));
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

    try {
      await this.subscribeClient(socket, client, message, {
        ...(message.confirmationsByDomain
          ? {
              confirmationsByDomain: Object.fromEntries(
                message.confirmationsByDomain,
              ),
            }
          : {}),
        streams: message.streams.map(subscriptionResponse),
        type: 'subscribed',
      });
    } catch (error) {
      if (error instanceof ConfirmationUnavailableError)
        this.rejectNegotiation(socket, formatError(error));
      else this.failSocket(socket, formatError(error));
    }
  }

  /** Both event endpoints negotiate, register, and start through this path. */
  private async subscribeClient(
    socket: WebSocket,
    client: Client,
    message: Extract<ClientMessage, { type: 'subscribe' }>,
    acknowledgement: Record<string, unknown>,
  ): Promise<void> {
    client.subscribing = true;
    const eventStreams = message.streams
      .filter((request) => request.eventType !== 'blocks')
      .flatMap((request) =>
        splitConfirmationStreams(request, message.confirmationsByDomain),
      );
    const blocks = message.streams.find(
      (request) => request.eventType === 'blocks',
    );
    if (blocks) await this.subscribeBlocks(socket, blocks.domains);
    const requests: Parameters<EventSource['subscribe']>[0] = [];
    for (const {
      eventType,
      confirmations,
      domains,
      includeZeroConfirmations,
    } of eventStreams) {
      if (!domains) continue;
      if (confirmations !== undefined)
        requests.push({ eventType, confirmations, domains });
      if (includeZeroConfirmations && confirmations !== 0)
        requests.push({
          eventType,
          confirmations: 0,
          domains,
          allowUnavailable: true,
        });
    }
    if (requests.length) await this.subscribeEvents(socket, client, requests);
    if (this.clients.get(socket) !== client) return;
    // Retain the canonical group for live filtering when policies are mixed.
    for (const request of eventStreams) {
      if (
        request.confirmations !== undefined &&
        client.subscriptions.has(request.eventType)
      )
        continue;
      client.subscriptions.set(request.eventType, request);
    }

    client.subscribing = false;
    this.send(socket, acknowledgement);
    client.events?.start();
    this.startBlocks(socket);
    for (const cursor of client.events?.starts ?? []) {
      if (
        !(await this.sendLiveStart(
          socket,
          client,
          cursor.domain,
          [cursor.eventType],
          cursor.boundary,
          cursor.confirmations,
        ))
      )
        return;
    }
    await this.sendLiveStarts(
      socket,
      client,
      eventStreams.filter((request) => request.confirmations === undefined),
    );
  }

  private async sendLiveStarts(
    socket: WebSocket,
    client: Client,
    streams: StreamRequest[],
  ): Promise<void> {
    if (!streams.length) return;
    const domains = streams.every((stream) => stream.domains)
      ? new Set(streams.flatMap((stream) => [...(stream.domains ?? [])]))
      : undefined;
    // Canonical subscriptions are registered before this primary DB read.
    // Consumers buffer from their acknowledgement, before the boundary frame.
    const store = this.validatorClients.has(socket)
      ? this.validatorStore
      : this.store;
    const boundaries = await store.liveStartBoundaries(domains);
    const requested = new Set([
      ...boundaries.keys(),
      ...streams.flatMap((stream) => [...(stream.domains ?? [])]),
    ]);
    for (const domain of requested) {
      const eventTypes = streams
        .filter((stream) => !stream.domains || stream.domains.has(domain))
        .map((stream) => stream.eventType);
      if (
        !(await this.sendLiveStart(
          socket,
          client,
          domain,
          eventTypes,
          boundaries.get(domain),
        ))
      )
        return;
    }
  }

  private sendLiveStart(
    socket: WebSocket,
    client: Client,
    domain: number,
    eventTypes: EventType[],
    boundary: LiveStartBoundary | undefined,
    confirmations?: number,
  ): Promise<boolean> {
    if (this.clients.get(socket) !== client) return Promise.resolve(false);
    const policy = confirmations === undefined ? {} : { confirmations };
    return this.sendAndWait(
      socket,
      boundary
        ? {
            type: 'live_start',
            domain,
            ...policy,
            height: boundary.height,
            hash: boundary.hash,
            streams: eventTypes.map((eventType) => ({
              eventType,
              address: boundary.contracts[eventType],
            })),
          }
        : {
            type: 'live_start_unavailable',
            domain,
            ...policy,
            eventTypes,
            reason: 'No healthy live-start scraper checkpoint',
          },
    );
  }

  private async publish(eventType: EventType, rows: Row[]): Promise<void> {
    const budget = Math.min(
      FANOUT_BYTES_PER_TURN,
      this.outboundQuota('validators'),
    );
    let bytes = 0;
    let sends = 0;
    for (const row of rows) {
      const domain = rowDomain(row, STREAMS[eventType].domain);
      let serialized: SerializedMessage | undefined;
      for (const [socket, client] of this.clients) {
        const request = client.subscriptions.get(eventType);
        if (
          !request ||
          request.confirmations !== undefined ||
          !matchesDomain(request, domain)
        )
          continue;
        serialized ??= serialize(eventMessage(eventType, row));
        if (bytes && bytes + serialized.length > budget) {
          bytes = 0;
          sends = 0;
          await nextTurn();
          if (this.clients.get(socket) !== client) continue;
        }
        this.queueData(socket, serialized);
        bytes += serialized.length;
        if (++sends >= FANOUT_MESSAGES_PER_TURN || bytes >= budget) {
          bytes = 0;
          sends = 0;
          await nextTurn();
        }
      }
    }
  }

  private notifySources(head: HeadNotification): void {
    this.eventSource.notify(head);
    this.validatorSource.notify(head);
    this.messageSource.notify(head);
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
        const head = parseHeadNotification(payload);
        this.messageSource.observe(head);
        if (!this.clients.size && !this.explorerClients.size) return;
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
        if (
          head.previousIndexedHeight !== undefined &&
          head.indexedHeight !== undefined &&
          head.indexedHeight < head.previousIndexedHeight
        ) {
          // A rollback must invalidate in-flight readers immediately; never
          // coalesce it away with a subsequent forward observation.
          this.pendingHeads.delete(head.domain);
          this.notifySources(head);
        } else {
          this.pendingHeads.set(head.domain, head);
          this.confirmationUpdates.schedule();
        }
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
        this.messageSource.invalidateIds([messageId]);
        this.queueExplorerNotification(messageId);
      } else {
        const notification = parseEventNotification(payload);
        if (!this.hasSubscriber(notification)) return;
        if (!this.hasSubscriber(notification, true)) {
          this.queueValidatorNotification(notification);
          return;
        }
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
    if (!this.hasExplorerSubscriber(messageId)) return;
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
        const live: EventNotification[] = [];
        for (const notification of notifications) {
          if (this.hasSubscriber(notification, true)) live.push(notification);
          else if (this.hasSubscriber(notification))
            this.queueValidatorNotification(notification);
        }
        if (live.length) await this.publishNotifications(eventType, live);
      }
    }
  }

  private queueValidatorNotification(notification: EventNotification): void {
    const key = notification.id.toString();
    if (
      !this.validatorNotifications.has(key) &&
      this.validatorNotifications.size >= MAX_PENDING_NOTIFICATIONS
    ) {
      websocketNotificationQueueOverflows.inc({ route: 'validators' });
      websocketSendFailures.inc({ reason: 'notification_queue_limit' });
      this.failValidatorStream(
        new Error('Validator notification queue limit exceeded'),
      );
      return;
    }
    this.validatorNotifications.set(key, notification);
    this.validatorUpdates.schedule();
  }

  private async drainValidatorUpdates(): Promise<void> {
    while (this.validatorNotifications.size) {
      const batch = [...this.validatorNotifications.values()].slice(
        0,
        NOTIFICATION_BATCH_SIZE,
      );
      batch.forEach(({ id }) =>
        this.validatorNotifications.delete(id.toString()),
      );
      try {
        await this.publishNotifications(
          'merkle_tree_insertion',
          batch,
          this.validatorStore,
        );
      } catch (error) {
        for (const domain of new Set(batch.map(({ domain }) => domain)))
          this.failValidatorDomain(domain, error);
      }
    }
    for (const [domain, range] of this.validatorHeadRanges) {
      try {
        for await (const rows of this.validatorStore.headEvents(
          'merkle_tree_insertion',
          domain,
          range.after,
          range.through,
        )) {
          if (this.stopped) return;
          await this.publish('merkle_tree_insertion', rows);
        }
      } catch (error) {
        this.failValidatorDomain(domain, error);
      }
      this.releaseHeadRange(domain, range, this.validatorHeadRanges);
    }
    if (this.validatorHeadRanges.size) this.validatorUpdates.schedule();
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
              this.failExplorerDomain(domain, failure.original);
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
  private releaseHeadRange(
    domain: number,
    range: HeadRange,
    ranges = this.headRanges,
  ): void {
    const current = ranges.get(domain);
    if (!current) return;
    if (current.through <= range.through) {
      ranges.delete(domain);
    } else {
      ranges.set(domain, {
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
    // Near-head deliveries and payments have no insert notification, so this
    // range is the only refresh for a message whose origin is another domain.
    const hasMessageClients = [...this.explorerClients.values()].some(
      (client) => client.ready && client.messageIds?.size !== 0,
    );
    let explorerPending = hasMessageClients;
    // Delivery and gas share message ids; queue each Explorer id once per range.
    const explorerIds = new Set<string>();
    for (const eventType of HEAD_PUBLICATION_ORDER) {
      const agentInterested = this.hasSubscriber({ domain, eventType });
      const explorerInterested =
        hasMessageClients &&
        (eventType === 'delivery' || eventType === 'gas_payment');
      if (!agentInterested && !explorerInterested) continue;
      if (
        agentInterested &&
        !explorerInterested &&
        !this.hasSubscriber({ domain, eventType }, true)
      ) {
        const current = this.validatorHeadRanges.get(domain);
        this.validatorHeadRanges.set(domain, {
          after: current && current.after < after ? current.after : after,
          through:
            current && current.through > through ? current.through : through,
        });
        this.validatorUpdates.schedule(0);
        continue;
      }
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
            await this.publish(eventType, events);
          }
          if (explorerInterested && this.explorerClients.size) {
            const batch: string[] = [];
            events.forEach((row) => {
              const messageId = row.msg_id ?? row.message_id;
              if (
                typeof messageId === 'string' &&
                !explorerIds.has(messageId) &&
                this.hasExplorerSubscriber(messageId)
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
    store = this.store,
  ): Promise<void> {
    const expected = new Map(
      notifications.map((notification) => [
        notification.id.toString(),
        notification,
      ]),
    );
    const stream = STREAMS[eventType];
    const rows = await store.notifiedEvents(eventType, [...expected.keys()]);
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
    await this.publish(eventType, events);
  }

  private hasExplorerSubscriber(messageId: string): boolean {
    for (const client of this.explorerClients.values())
      if (
        client.ready &&
        (!client.messageIds || client.messageIds.has(messageId))
      )
        return true;
    return false;
  }

  private explorerMessageIds(socket: WebSocket, ids: string[]): string[] {
    const filter = this.explorerClients.get(socket)?.messageIds;
    return filter ? ids.filter((id) => filter.has(id)) : ids;
  }

  private async publishExplorer(messageIds: string[]): Promise<void> {
    if (!this.explorerClients.size) return;
    this.messageSource.invalidateIds(messageIds);
    // Shared fact reads should not hold back head publication, but a backlog
    // must pace the drain rather than overflow the shared read queue.
    const refresh = this.messageSource
      .refresh(messageIds)
      .finally(() => this.explorerRefreshes.delete(refresh));
    this.explorerRefreshes.add(refresh);
    while (this.explorerRefreshes.size > MAX_EXPLORER_REFRESHES)
      await Promise.race(this.explorerRefreshes);
    await this.publishCanonicalMessages(messageIds);
  }

  private async publishCanonicalMessages(messageIds: string[]): Promise<void> {
    const canonicalIds = new Set<string>();
    for (const [socket, client] of this.explorerClients) {
      if (client.ready && !client.custom)
        for (const id of this.explorerMessageIds(socket, messageIds))
          canonicalIds.add(id);
    }
    if (!canonicalIds.size) return;
    let rows: Row[];
    try {
      rows = await this.store.canonicalMessages([...canonicalIds]);
    } catch (error) {
      for (const [socket, client] of this.explorerClients)
        if (
          client.ready &&
          !client.custom &&
          this.explorerMessageIds(socket, [...canonicalIds]).length
        )
          this.failSocket(socket, formatError(error));
      return;
    }
    const messages = rows.map((row) => ({
      id: row.msg_id,
      frame: serialize({ data: row, type: 'message_upsert' }),
    }));
    const budget = Math.min(
      FANOUT_BYTES_PER_TURN,
      this.outboundQuota('messages'),
    );
    let bytes = 0;
    for (const [socket, client] of this.explorerClients) {
      if (!client.ready || client.custom) continue;
      const frames = messages
        .filter(
          ({ id }) =>
            !client.messageIds ||
            (typeof id === 'string' && client.messageIds.has(id)),
        )
        .map(({ frame }) => frame);
      if (!frames.length) continue;
      const frameBytes = frames.reduce(
        (total, frame) => total + frame.length,
        0,
      );
      if (bytes && bytes + frameBytes > budget) {
        bytes = 0;
        await nextTurn();
        if (this.explorerClients.get(socket) !== client) continue;
      }
      this.explorerQueue.enqueue(socket, frames);
      bytes += frameBytes;
      if (bytes >= budget) {
        bytes = 0;
        await nextTurn();
      }
    }
  }

  private createBroadcastQueue(
    totalBytes = MAX_EXPLORER_TOTAL_PENDING_BYTES,
  ): BroadcastQueue {
    return new BroadcastQueue(
      {
        send: (socket, message) => this.sendSerializedAndWait(socket, message),
        fail: (socket) => {
          websocketSendFailures.inc({ reason: 'queue_limit' });
          this.failSocket(socket, 'outbound message queue limit exceeded');
        },
      },
      {
        messages: MAX_EXPLORER_PENDING_MESSAGES,
        bytes: MAX_EXPLORER_PENDING_BYTES,
        totalBytes,
      },
    );
  }

  private queueData(socket: WebSocket, message: Buffer): boolean {
    const route = this.routes.get(socket);
    const queue =
      route === 'validators'
        ? this.validatorQueue
        : route === 'messages'
          ? this.explorerQueue
          : this.eventQueue;
    return queue.enqueue(socket, [message]);
  }

  private hasSubscriber(
    { domain, eventType }: Pick<EventNotification, 'domain' | 'eventType'>,
    agentsOnly = false,
  ): boolean {
    for (const [socket, client] of this.clients) {
      if (agentsOnly && this.validatorClients.has(socket)) continue;
      const subscription = client.subscriptions.get(eventType);
      if (
        subscription &&
        subscription.confirmations === undefined &&
        matchesDomain(subscription, domain)
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
          matchesDomain(subscription, domain),
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

  private failExplorerDomain(domain: number, error: unknown): void {
    this.logger.error(
      `Explorer domain ${domain} failed: ${formatError(error)}`,
    );
    for (const [socket, client] of this.explorerClients)
      if (
        client.messageIds?.size !== 0 &&
        (!client.domains || client.domains.has(domain))
      )
        this.failSocket(socket, `Message domain ${domain} unavailable`);
  }

  private failValidatorDomain(domain: number, error: unknown): void {
    for (const socket of this.validatorClients.keys()) {
      const subscription = this.clients
        .get(socket)
        ?.subscriptions.get('merkle_tree_insertion');
      if (
        subscription &&
        subscription.confirmations === undefined &&
        subscription.domains?.has(domain)
      )
        this.failSocket(socket, formatError(error));
    }
  }

  private failValidatorStream(error: unknown): void {
    this.logger.error(`validator event stream failed: ${formatError(error)}`);
    this.validatorNotifications.clear();
    this.validatorHeadRanges.clear();
    for (const socket of this.validatorClients.keys()) {
      const subscription = this.clients
        .get(socket)
        ?.subscriptions.get('merkle_tree_insertion');
      if (subscription && subscription.confirmations === undefined)
        this.failSocket(socket, formatError(error));
    }
  }

  private closeClients(reason: string, code = 1013): void {
    this.eventSource.stop();
    this.validatorSource.stop();
    this.eventSource = new EventSource(this.store);
    this.validatorSource = new EventSource(
      this.validatorStore,
      VALIDATOR_SOURCE_LIMITS,
    );
    this.pendingHeads.clear();
    this.messageSource.stop();
    this.messageSource = new MessageSource(this.store);
    this.closeAgentClients(reason, code);
    this.closeExplorerClients(reason, code);
  }

  private closeAgentClients(reason: string, code = 1013): void {
    this.notifications.clear();
    this.validatorNotifications.clear();
    this.validatorHeadRanges.clear();
    this.headRanges.clear();
    this.headFailures.clear();
    for (const socket of this.clients.keys()) {
      this.disconnect(socket);
      socket.close(code, reason);
    }
  }

  private closeExplorerClients(reason: string, code = 1013): void {
    this.explorerNotifications.clear();
    for (const socket of this.explorerClients.keys()) {
      this.disconnect(socket);
      socket.close(code, reason);
    }
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

  private serializeShared(frame: Record<string, unknown>): SerializedMessage {
    let message = this.serializedFrames.get(frame);
    if (!message) {
      message = serialize(frame);
      this.serializedFrames.set(frame, message);
    }
    return message;
  }

  private send(socket: WebSocket, message: Record<string, unknown>): boolean {
    return this.sendSerialized(socket, serialize(message));
  }

  private sendDiagnostics(
    socket: WebSocket,
    frame: DiagnosticsFrame,
    complete?: (sent: boolean) => void,
  ): boolean {
    const client = this.explorerClients.get(socket);
    // Never queue diagnostics behind normal updates. The affected ID is retried.
    if (!client || this.explorerQueue.busy(socket)) {
      complete?.(false);
      return false;
    }
    const message = this.serializeShared(frame);
    // Leave at least half of both outbound budgets available for normal traffic.
    if (
      socket.bufferedAmount + message.length >
        this.limits.maxBufferedBytes / 2 ||
      this.pendingBytes + message.length >
        this.limits.maxTotalBufferedBytes / 2 ||
      this.routePending.messages + message.length >
        this.outboundQuota('messages') / 2
    ) {
      complete?.(false);
      return false;
    }
    const accepted = this.sendSerialized(socket, message, complete);
    if (!accepted) complete?.(false);
    return accepted;
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
    if (socket.bufferedAmount + message.length > this.limits.maxBufferedBytes) {
      websocketSendFailures.inc({ reason: 'buffer_limit' });
      this.failSocket(socket, 'outbound buffer limit exceeded');
      return false;
    }
    const route = this.routes.get(socket) ?? 'agent';
    // Public routes each get at most a quarter; agents retain half. Control
    // frames use these same limits, so ping/heartbeat traffic cannot bypass them.
    const quota = this.outboundQuota(route);
    while (
      this.routePending[route] + message.length > quota ||
      this.pendingBytes + message.length > this.limits.maxTotalBufferedBytes
    ) {
      const routeFull = this.routePending[route] + message.length > quota;
      let victim = socket;
      let largest =
        (this.pendingSends.get(socket)?.bytes ?? 0) + message.length;
      for (const [peer, pending] of this.pendingSends) {
        if (
          peer === socket ||
          (routeFull && pending.route !== route) ||
          (route !== 'agent' && pending.route === 'agent')
        )
          continue;
        if (
          pending.bytes > largest ||
          (!routeFull &&
            route === 'agent' &&
            pending.route !== 'agent' &&
            pending.bytes === largest)
        ) {
          victim = peer;
          largest = pending.bytes;
        }
      }
      websocketSendFailures.inc({ reason: 'buffer_limit' });
      this.failSocket(victim, 'outbound buffer limit exceeded');
      if (victim === socket) return false;
    }
    const pending = this.pendingSends.get(socket) ?? { route, bytes: 0 };
    this.pendingSends.set(socket, pending);
    pending.bytes += message.length;
    this.routePending[route] += message.length;
    this.pendingBytes += message.length;
    const release = () => {
      // Disconnect releases the entire reservation. Late send callbacks must
      // not subtract it again or consume a different socket's budget.
      if (this.pendingSends.get(socket) !== pending) return;
      pending.bytes -= message.length;
      this.pendingBytes -= message.length;
      this.routePending[route] -= message.length;
      if (!pending.bytes) this.pendingSends.delete(socket);
    };
    try {
      socket.send(message, { binary: false }, (error) => {
        release();
        completed?.(!error);
        if (error) this.failSend(socket, error.message);
      });
    } catch (error) {
      release();
      completed?.(false);
      this.failSend(socket, formatError(error));
      return false;
    }
    return true;
  }

  private releasePending(socket: WebSocket): void {
    const pending = this.pendingSends.get(socket);
    if (!pending) return;
    this.pendingBytes -= pending.bytes;
    this.routePending[pending.route] -= pending.bytes;
    this.pendingSends.delete(socket);
  }

  private outboundQuota(route: Route): number {
    return Math.min(
      this.limits.maxTotalBufferedBytes,
      Math.max(
        1024,
        Math.floor(
          this.limits.maxTotalBufferedBytes / (route === 'agent' ? 2 : 4),
        ),
      ),
    );
  }

  private failSocket(socket: WebSocket, reason: string): void {
    if (this.terminatedSockets.has(socket)) return;
    if (
      this.validatorClients.get(socket)?.pending &&
      this.clients.has(socket)
    ) {
      this.rejectNegotiation(socket, reason, 'setup_error', 1013);
      return;
    }
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
    this.eventQueue.remove(socket);
    this.validatorQueue.remove(socket);
    this.explorerQueue.remove(socket);
    this.releasePending(socket);
    this.blockSubscriptions.delete(socket);
    this.clients.get(socket)?.events?.stop();
    this.clients.delete(socket);
    this.releaseValidator(socket);
    const explorerClient = this.explorerClients.get(socket);
    if (explorerClient) {
      explorerClient.unsubscribe?.();
      this.releaseExplorerClient(explorerClient.ip);
    }
    this.explorerClients.delete(socket);
    if (!this.clients.size && !this.explorerClients.size)
      this.pendingHeads.clear();
  }

  private releaseExplorerClient(ip: string): void {
    const connections = this.explorerClientsByIp.get(ip);
    if (!connections) return;
    if (connections === 1) this.explorerClientsByIp.delete(ip);
    else this.explorerClientsByIp.set(ip, connections - 1);
  }

  private releaseExplorerSetup(socket: WebSocket): void {
    const ip = this.explorerPendingSetups.get(socket);
    if (!ip) return;
    this.explorerPendingSetups.delete(socket);
    const pending = this.explorerPendingSetupsByIp.get(ip);
    if (!pending || pending === 1) this.explorerPendingSetupsByIp.delete(ip);
    else this.explorerPendingSetupsByIp.set(ip, pending - 1);
  }

  private releaseValidator(socket: WebSocket): void {
    const client = this.validatorClients.get(socket);
    if (!client || client.pending || socket.readyState !== WebSocket.CLOSED)
      return;
    this.validatorClients.delete(socket);
  }

  private rejectNegotiation(
    socket: WebSocket,
    error: string,
    reason = 'invalid_subscription',
    code = 1008,
  ): void {
    if (this.validatorClients.has(socket))
      websocketConnectionRejections.inc({
        route: 'validators',
        reason,
      });
    this.disconnect(socket);
    if (code === 1013) this.logger.warn(`stream setup failed: ${error}`);
    else this.sendError(socket, error);
    socket.close(
      code,
      code === 1013 ? 'Stream unavailable' : 'Invalid subscription',
    );
  }

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
}

function serialize(message: Record<string, unknown>): SerializedMessage {
  // Explorer broadcasts share this payload; encode UTF-8 once for every recipient.
  return Buffer.from(JSON.stringify(message));
}

function matchesDomain(request: StreamRequest, domain: number): boolean {
  return !request.domains || request.domains.has(domain);
}

function subscriptionResponse(
  request: StreamRequest | BlockStreamRequest,
): Record<string, unknown> {
  return {
    confirmations: request.confirmations,
    ...(request.includeZeroConfirmations !== undefined
      ? { includeZeroConfirmations: request.includeZeroConfirmations }
      : {}),
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
