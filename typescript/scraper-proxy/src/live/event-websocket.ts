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
import { quoteIdentifier as q, tables } from '../scraperdb/tables.js';
import {
  displayAddress,
  EVENT_TYPES,
  type EventNotification,
  type EventType,
  isDomain,
  isSequencedEventType,
  normalizeSequenceAddress,
  parseDatabaseDomain,
  parseClientMessage,
  parseEventNotification,
  parseExplorerNotification,
  parseHeadNotification,
  parseId,
  parseInteger,
  type GasPaymentCursor,
  type HeadNotification,
  type SequenceCursor,
  type StreamCursor,
  type StreamRequest,
  STREAM_CURSOR_VERSIONS,
} from './protocol.js';
import { rawData } from './websocket-data.js';

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
const MAX_PENDING_EVENTS = 5_000;
const MAX_PENDING_NOTIFICATIONS = 10_000;
const MAX_HEAD_PUBLICATION_FAILURES = 3;
const GAS_PAYMENT_STREAM_CURSOR = 'gas_payment_stream_cursor';
const GAS_PAYMENT_STREAM_HEAD = 'gas_payment_stream_head';
const STREAM_CURSOR_COLUMN = 'scraper_stream_cursor';
const GAS_PAYMENT_TRANSACTION = 'event_transaction';
const GAS_PAYMENT_BLOCK = 'event_block';
const FRONTIER_ID = 'frontier_id';
const FRONTIER_HEIGHT = 'frontier_height';

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
  frontiers: Map<number, bigint>;
  gasPaymentLegacyMaxIds: Map<string, bigint>;
  pending: Row[];
  confirmations?: number;
  streamCursors: Map<string, bigint>;
  sequences: Map<string, bigint>;
  waiting: boolean;
};
type Client = {
  alive: boolean;
  messages: number;
  messageWindow: number;
  subscribing: boolean;
  subscriptions: Map<EventType, Subscription>;
};
type ExplorerClient = {
  alive: boolean;
  canonical: boolean;
  confirmations?: number;
  domains?: Set<number>;
  frontiers: Map<number, bigint>;
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
type HeadState = { head: bigint; indexed: bigint };
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

const CUSTOM_CONFIRMATION_TABLES: Record<EventType, string> = {
  delivery: 'delivered_message',
  dispatch: 'raw_message_dispatch',
  gas_payment: 'gas_payment',
  merkle_tree_insertion: 'merkle_tree_insertion',
};

const STREAM_HEIGHTS: Record<EventType, string> = {
  delivery: 'block_number',
  dispatch: 'origin_block_height',
  gas_payment: 'block_number',
  merkle_tree_insertion: 'block_number',
};

const PROVISIONAL_MESSAGE_QUERY = `
  /* provisional_message_view */
  WITH supplied_frontier(domain, height) AS (
    SELECT * FROM unnest($2::integer[], $3::bigint[])
  ), frontier AS (
    SELECT domain, CASE WHEN domain=$4 THEN $5::bigint ELSE height END AS height
    FROM supplied_frontier
  ), eligible_dispatch AS (
    SELECT dispatch.*
    FROM raw_message_dispatch dispatch
    LEFT JOIN frontier ON frontier.domain=dispatch.origin_domain
    LEFT JOIN scraper_head ON scraper_head.domain=dispatch.origin_domain
    WHERE dispatch.msg_id=ANY($1::bytea[])
      AND dispatch.origin_block_height<=coalesce(frontier.height,
        scraper_head.confirmed_height, 9223372036854775807)
  ), eligible_delivery AS (
    SELECT DISTINCT ON (delivery.msg_id) delivery.*
    FROM delivered_message delivery
    LEFT JOIN frontier ON frontier.domain=delivery.domain
    LEFT JOIN scraper_head ON scraper_head.domain=delivery.domain
    WHERE delivery.msg_id=ANY($1::bytea[])
      AND (delivery.block_number IS NULL OR delivery.block_number<=coalesce(
        frontier.height, scraper_head.confirmed_height, 9223372036854775807))
    ORDER BY delivery.msg_id, delivery.block_number DESC NULLS LAST, delivery.id DESC
  ), eligible_payment AS (
    SELECT payment.msg_id, count(*)::bigint AS num_payments,
      sum(payment.payment) AS total_payment,
      sum(payment.gas_amount) AS total_gas_amount
    FROM gas_payment payment
    LEFT JOIN frontier ON frontier.domain=payment.domain
    LEFT JOIN scraper_head ON scraper_head.domain=payment.domain
    WHERE payment.msg_id=ANY($1::bytea[])
      AND (payment.block_number IS NULL OR payment.block_number<=coalesce(
        frontier.height, scraper_head.confirmed_height, 9223372036854775807))
    GROUP BY payment.msg_id
  )
  SELECT
    dispatch.id,
    dispatch.msg_id,
    dispatch.nonce,
    delivery.id IS NOT NULL AS is_delivered,
    coalesce(payment.num_payments, 0) AS num_payments,
    coalesce(payment.total_payment, 0) AS total_payment,
    coalesce(payment.total_gas_amount, 0) AS total_gas_amount,
    dispatch.origin_domain AS origin_domain_id,
    origin_domain.chain_id AS origin_chain_id,
    origin_domain.name AS origin_domain,
    dispatch.destination_domain AS destination_domain_id,
    destination_domain.chain_id AS destination_chain_id,
    destination_domain.name AS destination_domain,
    dispatch.time_created AS send_scraped_at,
    origin_block.timestamp AS send_occurred_at,
    delivery.time_created AS delivery_scraped_at,
    destination_block.timestamp AS delivery_occurred_at,
    destination_block.timestamp-origin_block.timestamp AS delivery_latency,
    dispatch.time_created-origin_block.timestamp AS send_scape_latency,
    delivery.time_created-destination_block.timestamp AS delivery_scape_latency,
    dispatch.sender,
    dispatch.recipient,
    dispatch.origin_mailbox,
    delivery.destination_mailbox,
    origin_tx.id AS origin_tx_id,
    coalesce(origin_tx.hash, dispatch.origin_tx_hash) AS origin_tx_hash,
    origin_tx.gas_limit AS origin_tx_gas_limit,
    origin_tx.max_priority_fee_per_gas AS origin_tx_max_priority_fee_per_gas,
    origin_tx.max_fee_per_gas AS origin_tx_max_fee_per_gas,
    origin_tx.gas_price AS origin_tx_gas_price,
    origin_tx.effective_gas_price AS origin_tx_effective_gas_price,
    origin_tx.nonce AS origin_tx_nonce,
    origin_tx.sender AS origin_tx_sender,
    origin_tx.recipient AS origin_tx_recipient,
    origin_tx.gas_used AS origin_tx_gas_used,
    origin_tx.cumulative_gas_used AS origin_tx_cumulative_gas_used,
    origin_block.id AS origin_block_id,
    dispatch.origin_block_height,
    dispatch.origin_block_hash,
    destination_tx.id AS destination_tx_id,
    coalesce(destination_tx.hash, delivery.transaction_hash) AS destination_tx_hash,
    destination_tx.gas_limit AS destination_tx_gas_limit,
    destination_tx.max_priority_fee_per_gas AS destination_tx_max_priority_fee_per_gas,
    destination_tx.max_fee_per_gas AS destination_tx_max_fee_per_gas,
    destination_tx.gas_price AS destination_tx_gas_price,
    destination_tx.effective_gas_price AS destination_tx_effective_gas_price,
    destination_tx.nonce AS destination_tx_nonce,
    destination_tx.sender AS destination_tx_sender,
    destination_tx.recipient AS destination_tx_recipient,
    destination_tx.gas_used AS destination_tx_gas_used,
    destination_tx.cumulative_gas_used AS destination_tx_cumulative_gas_used,
    destination_block.id AS destination_block_id,
    delivery.block_number AS destination_block_height,
    delivery.block_hash AS destination_block_hash,
    dispatch.msg_body AS message_body
  FROM eligible_dispatch dispatch
  LEFT JOIN domain origin_domain ON origin_domain.id=dispatch.origin_domain
  LEFT JOIN domain destination_domain ON destination_domain.id=dispatch.destination_domain
  LEFT JOIN block origin_block ON origin_block.domain=dispatch.origin_domain
    AND origin_block.hash=dispatch.origin_block_hash
  LEFT JOIN "transaction" origin_tx ON origin_tx.block_id=origin_block.id
    AND origin_tx.hash=dispatch.origin_tx_hash
  LEFT JOIN eligible_delivery delivery ON delivery.msg_id=dispatch.msg_id
  LEFT JOIN block destination_block ON destination_block.domain=delivery.domain
    AND destination_block.hash=delivery.block_hash
  LEFT JOIN "transaction" destination_tx ON destination_tx.id=delivery.destination_tx_id
    OR (delivery.destination_tx_id IS NULL AND destination_tx.block_id=destination_block.id
      AND destination_tx.hash=delivery.transaction_hash)
  LEFT JOIN eligible_payment payment ON payment.msg_id=dispatch.msg_id
  WHERE origin_block.timestamp IS NOT NULL
`;

const EVENT_DOMAIN_COLUMNS: Record<EventType, readonly string[]> = {
  delivery: ['domain'],
  dispatch: ['origin_domain', 'destination_domain'],
  gas_payment: ['domain', 'origin', 'destination'],
  merkle_tree_insertion: ['domain'],
};

export class EventWebSocketServer {
  private readonly logger = rootLogger.child({
    module: EventWebSocketServer.name,
  });
  private readonly clients = new Map<WebSocket, Client>();
  private readonly terminatedSockets = new WeakSet<WebSocket>();
  private readonly explorerClients = new Map<WebSocket, ExplorerClient>();
  private readonly explorerClientsByIp = new Map<string, number>();
  private readonly catchUpWaiters: CatchUpWaiter[] = [];
  private readonly explorerNotifications = new Set<string>();
  private readonly notifications = new Map<string, EventNotification>();
  private readonly headRanges = new Map<number, HeadRange>();
  private readonly customHeads = new Map<number, HeadNotification>();
  private readonly rollbackEpochs = new Map<number, number>();
  private readonly headFailures = new Map<number, number>();
  private heartbeatTimer?: NodeJS.Timeout;
  private listenerRetryTimer?: NodeJS.Timeout;
  private agentNotificationTimer?: NodeJS.Timeout;
  private headNotificationTimer?: NodeJS.Timeout;
  private explorerNotificationTimer?: NodeJS.Timeout;
  private drainingAgentNotifications = false;
  private drainingHeadNotifications = false;
  private drainingExplorerNotifications = false;
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
    limits: Partial<Limits> = {},
  ) {
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
      (socket, request) => void this.connectExplorer(socket, request),
    );
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.logger.info(
      `event websockets listening on ${AGENT_PATH}, ${MESSAGE_PATH} batchSize=${config.EVENT_STREAM_BATCH_SIZE} maxAgentClients=${this.limits.maxAgentClients} maxBufferedBytes=${this.limits.maxBufferedBytes} maxTotalBufferedBytes=${this.limits.maxTotalBufferedBytes}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    [
      this.heartbeatTimer,
      this.listenerRetryTimer,
      this.agentNotificationTimer,
      this.headNotificationTimer,
      this.explorerNotificationTimer,
    ].forEach((timer) => timer && clearTimeout(timer));
    this.explorerNotifications.clear();
    this.notifications.clear();
    this.headRanges.clear();
    this.customHeads.clear();
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
          subscription.catchingUp ? 'catchingUp' : 'live'
        ]++;
        pendingCatchUpEvents += subscription.pending.length;
        maxPendingCatchUpEvents = Math.max(
          maxPendingCatchUpEvents,
          subscription.pending.length,
        );
        if (subscription.catchingUp) {
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
    this.watch(socket, this.clients, (client) => {
      client.subscriptions.clear();
      this.cancelCatchUp(socket);
    });
    if (!this.accept(socket, 'agent')) return;
    this.clients.set(socket, {
      alive: true,
      messages: 0,
      messageWindow: Date.now(),
      subscribing: false,
      subscriptions: new Map(),
    });
    websocketConnections.inc({ route: 'agent' });
    this.send(socket, {
      controlTypes: ['rollback'],
      eventTypes: EVENT_TYPES,
      historicalStreaming: true,
      confirmations: { unit: 'blocks' },
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
    this.watch(socket, this.explorerClients, (client) => {
      this.clearExplorerQueue(client);
      this.releaseExplorerClient(client.ip);
    });
    if (!this.accept(socket, 'explorer')) return;
    let custom: { confirmations: number; domains: Set<number> } | undefined;
    try {
      custom = parseExplorerConfirmations(request.url);
    } catch (error) {
      socket.close(1008, formatError(error));
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
    const client: ExplorerClient = {
      alive: true,
      canonical: custom === undefined,
      confirmations: custom?.confirmations,
      domains: custom?.domains,
      frontiers: new Map(),
      ip,
      queuedBytes: 0,
      queue: [],
      sending: false,
    };
    this.explorerClients.set(socket, client);
    websocketConnections.inc({ route: 'messages' });
    if (custom) {
      try {
        const states = await this.availableHeadStates(custom.domains);
        if (this.explorerClients.get(socket) !== client) return;
        client.canonical = states.size < custom.domains.size;
        client.domains = new Set(
          [...custom.domains].filter((domain) => states.has(domain)),
        );
        client.frontiers = new Map(
          [...states].map(([domain, state]) => [
            domain,
            customFrontier(state, custom.confirmations),
          ]),
        );
      } catch (error) {
        this.logger.warn(
          `rejecting Explorer confirmation request: ${formatError(error)}`,
        );
        this.disconnect(socket);
        socket.close(1008, 'Unsupported confirmation domains');
        return;
      }
    }
    this.send(socket, {
      controlTypes: custom ? ['rollback'] : undefined,
      confirmations: custom?.confirmations,
      domains: custom ? [...(client.domains ?? [])] : undefined,
      eventTypes: custom ? ['message_upsert', 'rollback'] : ['message_upsert'],
      type: 'ready',
    });
    if (custom) {
      try {
        const latest = await this.headStates(client.domains ?? new Set());
        if (this.explorerClients.get(socket) !== client) return;
        for (const [domain, state] of latest) {
          this.customHeads.set(domain, {
            confirmedHeight: 0n,
            domain,
            headHeight: state.head,
            indexedHeight: state.indexed,
          });
        }
        this.scheduleHeadDrain();
      } catch (error) {
        this.logger.error(
          `Explorer confirmation initialization failed: ${formatError(error)}`,
        );
        this.disconnect(socket);
        socket.close(1013, 'Event stream initialization failed');
      }
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
    if (client.subscribing || client.subscriptions.size) {
      this.sendError(socket, 'Already subscribed');
      return;
    }
    client.subscribing = true;

    let customHeadStates: Map<number, HeadState>;
    try {
      customHeadStates = await this.customHeadStates(message.streams);
    } catch (error) {
      client.subscribing = false;
      this.sendError(socket, formatError(error));
      return;
    }
    if (this.clients.get(socket) !== client) return;

    for (const request of message.streams) {
      const frontiers = new Map<number, bigint>();
      if (request.confirmations !== undefined) {
        for (const domain of request.domains ?? []) {
          const head = customHeadStates.get(domain);
          if (!head) continue;
          frontiers.set(domain, customFrontier(head, request.confirmations));
        }
      }
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
        frontiers,
        gasPaymentLegacyMaxIds: new Map(),
        pending: [],
        confirmations: request.confirmations,
        streamCursors: new Map(),
        sequences: new Map(),
        waiting: !!request.cursors,
      });
    }
    if (customHeadStates.size) {
      try {
        const latest = await this.customHeadStates(message.streams);
        if (this.clients.get(socket) !== client) return;
        for (const [domain, state] of latest) {
          if (!this.customHeads.has(domain)) {
            this.customHeads.set(domain, {
              confirmedHeight: 0n,
              domain,
              headHeight: state.head,
              indexedHeight: state.indexed,
            });
          }
        }
        this.scheduleHeadDrain();
      } catch (error) {
        client.subscriptions.clear();
        client.subscribing = false;
        this.sendError(socket, formatError(error));
        return;
      }
    }
    client.subscribing = false;
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

  private async customHeadStates(
    requests: StreamRequest[],
  ): Promise<Map<number, HeadState>> {
    const domains = new Set(
      requests.flatMap((request) =>
        request.confirmations === undefined ? [] : [...(request.domains ?? [])],
      ),
    );
    if (!domains.size) return new Map();
    return this.headStates(domains);
  }

  private async headStates(
    domains: ReadonlySet<number>,
  ): Promise<Map<number, HeadState>> {
    const states = await this.availableHeadStates(domains);
    const missing = [...domains].filter((domain) => !states.has(domain));
    if (missing.length) {
      throw new Error(
        `confirmations is unsupported for domains: ${missing.join(', ')}`,
      );
    }
    return states;
  }

  private async availableHeadStates(
    domains: ReadonlySet<number>,
  ): Promise<Map<number, HeadState>> {
    const rows = await this.db.queryLive<{
      domain: number | string;
      head_height: string;
      indexed_height: string;
    }>(
      `SELECT ${q('domain')}, ${q('indexed_height')}::text, ${q('head_height')}::text FROM ${q('scraper_head')} WHERE ${q('domain')} = ANY($1::integer[])`,
      [[...domains].map(storedDomain)],
    );
    const states = new Map<number, HeadState>();
    for (const row of rows) {
      const domain = parseDatabaseDomain(row.domain, 'Invalid scraper head');
      states.set(domain, {
        head: parseId(row.head_height),
        indexed: parseId(row.indexed_height),
      });
    }
    return states;
  }

  private async catchUp(
    socket: WebSocket,
    client: Client,
    request: StreamRequest,
  ): Promise<void> {
    const subscription = client.subscriptions.get(request.eventType);
    if (!subscription) return;
    if (!(await this.reserveCatchUp(socket))) return;
    subscription.catchUpStartedAt = Date.now();
    subscription.waiting = false;
    try {
      for (const cursor of request.cursors ?? []) {
        if (
          this.clients.get(socket) !== client ||
          client.subscriptions.get(request.eventType) !== subscription
        ) {
          websocketCatchUps.inc({ outcome: 'aborted' });
          return;
        }
        const completed = await this.catchUpCursor(
          socket,
          client,
          request.eventType,
          subscription,
          cursor,
        );
        if (!completed) {
          websocketCatchUps.inc({ outcome: 'aborted' });
          return;
        }
      }
      while (subscription.pending.length) {
        if (
          this.clients.get(socket) !== client ||
          client.subscriptions.get(request.eventType) !== subscription
        ) {
          websocketCatchUps.inc({ outcome: 'aborted' });
          return;
        }
        const pending = subscription.pending.sort((a, b) =>
          compareRows(request.eventType, a, b),
        );
        subscription.pending = [];
        for (const row of pending) {
          this.assertCatchUpBudget(subscription);
          if (
            !(await this.deliverAndWait(
              socket,
              request.eventType,
              subscription,
              row,
            ))
          ) {
            websocketCatchUps.inc({ outcome: 'failure' });
            return;
          }
        }
      }
      subscription.catchingUp = false;
      websocketCatchUps.inc({ outcome: 'success' });
    } catch (error) {
      const active =
        this.clients.get(socket) === client &&
        client.subscriptions.get(request.eventType) === subscription;
      if (!active) {
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

  private async catchUpCursor(
    socket: WebSocket,
    client: Client,
    eventType: EventType,
    subscription: Subscription,
    cursor: StreamCursor,
  ): Promise<boolean> {
    return cursor.kind === 'gas_payment'
      ? this.catchUpGasPaymentCursor(
          socket,
          client,
          eventType,
          subscription,
          cursor,
        )
      : this.catchUpSequenceCursor(
          socket,
          client,
          eventType,
          subscription,
          cursor,
        );
  }

  private async catchUpSequenceCursor(
    socket: WebSocket,
    client: Client,
    eventType: EventType,
    subscription: Subscription,
    cursor: SequenceCursor,
  ): Promise<boolean> {
    const key = sequenceKey(cursor.domain, cursor.address);
    const { first, last } = await this.sequenceBounds(
      eventType,
      subscription,
      cursor,
    );
    if (last < first) {
      if (cursor.afterSequence !== undefined && cursor.afterSequence !== -1n) {
        throw new Error(
          `No ${eventType} history for domain ${cursor.domain} address ${displayAddress(cursor.address)}`,
        );
      }
      subscription.sequences.set(key, last);
      return this.sendAndWait(socket, {
        address: displayAddress(cursor.address),
        domain: cursor.domain,
        eventType,
        sequence: last.toString(),
        type: 'caught_up',
      });
    }
    const requestedAfter = cursor.afterSequence ?? last;
    if (requestedAfter > last && !cursor.allowReplay) {
      throw new Error(
        `Sequence ${requestedAfter} is ahead of current ${eventType} sequence ${last}`,
      );
    }
    const after = requestedAfter > last ? last : requestedAfter;
    subscription.sequences.set(key, after);

    while ((subscription.sequences.get(key) ?? -1n) < last) {
      if (
        this.clients.get(socket) !== client ||
        client.subscriptions.get(eventType) !== subscription
      ) {
        return false;
      }
      const current = subscription.sequences.get(key) ?? -1n;
      this.assertCatchUpBudget(subscription);
      const rows = await this.sequenceRows(
        eventType,
        subscription,
        cursor,
        current,
        last,
      );
      subscription.catchUpRows += rows.length;
      this.assertCatchUpBudget(subscription);
      if (!rows.length)
        throw new Error(`Missing ${eventType} sequence ${current + 1n}`);
      for (const row of rows) {
        this.assertCatchUpBudget(subscription);
        if (
          !(await this.deliverAndWait(socket, eventType, subscription, row))
        ) {
          throw new Error(`Gap in ${eventType} sequence after ${current}`);
        }
      }
    }
    if (
      !(await this.sendAndWait(socket, {
        address: displayAddress(cursor.address),
        domain: cursor.domain,
        eventType,
        sequence: last.toString(),
        type: 'caught_up',
      }))
    )
      throw new Error('Websocket closed during catch-up');
    return true;
  }

  private async catchUpGasPaymentCursor(
    socket: WebSocket,
    client: Client,
    eventType: EventType,
    subscription: Subscription,
    cursor: GasPaymentCursor,
  ): Promise<boolean> {
    const key = sequenceKey(cursor.domain, cursor.address);
    const { lastCursor, legacyMaxId } =
      await this.gasPaymentCursorBounds(cursor);
    const after = cursor.afterStreamCursor ?? lastCursor;
    if (after > lastCursor) {
      throw new Error(
        `Cursor ${after} is ahead of current ${eventType} cursor ${lastCursor}`,
      );
    }
    subscription.gasPaymentLegacyMaxIds.set(key, legacyMaxId);
    subscription.streamCursors.set(key, after);

    while ((subscription.streamCursors.get(key) ?? 0n) < lastCursor) {
      if (
        this.clients.get(socket) !== client ||
        client.subscriptions.get(eventType) !== subscription
      ) {
        return false;
      }
      const current = subscription.streamCursors.get(key) ?? 0n;
      this.assertCatchUpBudget(subscription);
      const legacyPhase = current < legacyMaxId;
      const through = legacyPhase ? legacyMaxId : lastCursor;
      const rows = legacyPhase
        ? await this.legacyGasPaymentRows(cursor, current, through)
        : await this.mappedGasPaymentRows(cursor, current, through);
      subscription.catchUpRows += rows.length;
      this.assertCatchUpBudget(subscription);
      if (!rows.length) {
        if (!legacyPhase) {
          throw new Error(`Missing ${eventType} stream cursor ${current + 1n}`);
        }
        subscription.streamCursors.set(key, through);
        continue;
      }
      for (const row of rows) {
        this.assertCatchUpBudget(subscription);
        if (
          !(await this.deliverAndWait(socket, eventType, subscription, row))
        ) {
          throw new Error(`Gap in ${eventType} stream cursor after ${current}`);
        }
      }
    }
    const streamCursor = subscription.streamCursors.get(key) ?? after;
    if (
      !(await this.sendAndWait(socket, {
        address: displayAddress(cursor.address),
        domain: cursor.domain,
        eventType,
        legacyMaxStreamCursor: legacyMaxId.toString(),
        streamCursor: streamCursor.toString(),
        type: 'caught_up',
      }))
    )
      throw new Error('Websocket closed during catch-up');
    return true;
  }

  private publish(
    eventType: EventType,
    row: Row,
    confirmations?: number,
    customHeight?: bigint,
  ): void {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    const key = rowCursorKey(eventType, domain, row);
    let serialized: SerializedMessage | undefined;
    for (const [socket, client] of this.clients) {
      const subscription = client.subscriptions.get(eventType);
      if (
        !subscription ||
        subscription.confirmations !== confirmations ||
        !matches(subscription, domain, key)
      )
        continue;
      if (confirmations !== undefined) {
        const frontier = subscription.frontiers.get(domain);
        if (
          frontier === undefined ||
          customHeight === undefined ||
          customHeight <= frontier
        )
          continue;
      }
      if (!subscription.catchingUp) {
        const message = this.eventForDelivery(
          socket,
          eventType,
          subscription,
          row,
        );
        if (!message) continue;
        // Gas payment envelopes include each subscriber's legacy cursor boundary.
        const payload =
          eventType === 'gas_payment'
            ? serialize(message)
            : (serialized ??= serialize(message));
        this.sendSerialized(socket, payload);
      } else if (
        !subscription.waiting &&
        subscription.pending.push(row) > MAX_PENDING_EVENTS
      ) {
        this.disconnect(socket);
        socket.close(1013, 'Event catch-up buffer exceeded');
      }
    }
  }

  private async deliverAndWait(
    socket: WebSocket,
    eventType: EventType,
    subscription: Subscription,
    row: Row,
  ): Promise<boolean> {
    const message = this.eventForDelivery(socket, eventType, subscription, row);
    if (message === false) return false;
    if (message === undefined) return true;
    if (!(await this.sendAndWait(socket, message))) {
      throw new Error('Websocket closed during catch-up');
    }
    return true;
  }

  private eventForDelivery(
    socket: WebSocket,
    eventType: EventType,
    subscription: Subscription,
    row: Row,
  ): Record<string, unknown> | false | undefined {
    const domain = rowDomain(row, STREAMS[eventType].domain);
    const key = rowCursorKey(eventType, domain, row);
    if (!matches(subscription, domain, key)) return undefined;
    const streamCursor = gasPaymentStreamCursor(eventType, row);
    if (streamCursor && subscription.cursorKeys) {
      const streamCursorKey = sequenceKey(domain, streamCursor.address);
      const current = subscription.streamCursors.get(streamCursorKey);
      if (current !== undefined) {
        if (streamCursor.value <= current) return undefined;
        const legacyMaxId =
          subscription.gasPaymentLegacyMaxIds.get(streamCursorKey);
        if (
          legacyMaxId !== undefined &&
          streamCursor.value > legacyMaxId &&
          streamCursor.value !== current + 1n
        ) {
          socket.close(
            1013,
            `${eventType} stream cursor gap: expected ${current + 1n}, received ${streamCursor.value}`,
          );
          return false;
        }
        subscription.streamCursors.set(streamCursorKey, streamCursor.value);
      }
    }
    const sequence = rowSequence(eventType, row);
    if (sequence) {
      const sequenceCursorKey = sequenceKey(domain, sequence.address);
      const current = subscription.sequences.get(sequenceCursorKey);
      if (current === undefined) {
        if (subscription.cursorKeys?.has(sequenceCursorKey))
          subscription.sequences.set(sequenceCursorKey, sequence.value);
      } else {
        if (sequence.value <= current) return undefined;
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
    const data = eventData(eventType, row);
    const rowId =
      eventType === 'gas_payment' ? parseId(row.id).toString() : undefined;
    const legacyMaxStreamCursor = streamCursor
      ? subscription.gasPaymentLegacyMaxIds.get(
          sequenceKey(domain, streamCursor.address),
        )
      : undefined;
    return {
      data,
      domain,
      eventType,
      legacyMaxStreamCursor: legacyMaxStreamCursor?.toString(),
      rowId,
      streamCursor: streamCursor?.value.toString(),
      sequence: sequence?.value.toString(),
      type: 'event',
    };
  }

  private assertCatchUpBudget(subscription: Subscription): void {
    if (Date.now() - subscription.catchUpStartedAt > this.limits.maxCatchUpMs) {
      throw new Error(
        `Historical streaming time limit exceeded (${this.limits.maxCatchUpMs}ms)`,
      );
    }
  }

  private sequenceRows(
    eventType: EventType,
    subscription: Subscription,
    cursor: SequenceCursor,
    after: bigint,
    through: bigint,
  ): Promise<Row[]> {
    const stream = subscriptionStream(eventType, subscription);
    const sequence = sequenceConfig(stream);
    const frontier = subscription.frontiers.get(cursor.domain);
    const frontierFilter =
      frontier === undefined
        ? ''
        : ` AND ${q(STREAM_HEIGHTS[eventType])} <= $6::bigint`;
    return this.db.queryLive<Row>(
      `SELECT ${columns(stream)} FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea AND ${q(sequence.value)} > $3::bigint AND ${q(sequence.value)} <= $4::bigint${frontierFilter} ORDER BY ${q(sequence.value)} ASC LIMIT $5`,
      [
        storedDomain(cursor.domain),
        cursor.address,
        after.toString(),
        through.toString(),
        config.EVENT_STREAM_BATCH_SIZE,
        ...(frontier === undefined ? [] : [frontier.toString()]),
      ],
    );
  }

  private async sequenceBounds(
    eventType: EventType,
    subscription: Subscription,
    cursor: SequenceCursor,
  ): Promise<{ first: bigint; last: bigint }> {
    const stream = subscriptionStream(eventType, subscription);
    const sequence = sequenceConfig(stream);
    const frontier = subscription.frontiers.get(cursor.domain);
    const frontierFilter =
      frontier === undefined
        ? ''
        : ` AND ${q(STREAM_HEIGHTS[eventType])} <= $3::bigint`;
    const [row] = await this.db.queryLive<{ first: string; last: string }>(
      `SELECT COALESCE(MIN(${q(sequence.value)}), 0)::text AS first, COALESCE(MAX(${q(sequence.value)}), -1)::text AS last FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q(sequence.address)} = $2::bytea${frontierFilter}`,
      [
        storedDomain(cursor.domain),
        cursor.address,
        ...(frontier === undefined ? [] : [frontier.toString()]),
      ],
    );
    return {
      first: parseSequence(row?.first ?? '0'),
      last: parseSequence(row?.last ?? '-1'),
    };
  }

  private legacyGasPaymentRows(
    cursor: GasPaymentCursor,
    after: bigint,
    through: bigint,
  ): Promise<Row[]> {
    const stream = STREAMS.gas_payment;
    // Limit payments before joining metadata; joining first enriches every
    // remaining row in the range before the planner applies the batch limit.
    return this.db.queryLive<Row>(
      `SELECT ${gasPaymentColumns(stream)}, ${q('event_row')}.${q('id')} AS ${q(STREAM_CURSOR_COLUMN)} FROM (SELECT * FROM ${q(stream.table)} WHERE ${q(stream.domain)} = $1 AND ${q('interchain_gas_paymaster')} = $2::bytea AND ${q('id')} > $3::bigint AND ${q('id')} <= $4::bigint ORDER BY ${q('id')} ASC LIMIT $5) AS ${q('event_row')}${gasPaymentMetadataJoins('LEFT JOIN')} ORDER BY ${q('event_row')}.${q('id')} ASC`,
      [
        storedDomain(cursor.domain),
        cursor.address,
        after.toString(),
        through.toString(),
        config.EVENT_STREAM_BATCH_SIZE,
      ],
    );
  }

  private mappedGasPaymentRows(
    cursor: GasPaymentCursor,
    after: bigint,
    through: bigint,
  ): Promise<Row[]> {
    const stream = STREAMS.gas_payment;
    // Cursors are only assigned to confirmed payments, so limiting cursors
    // before the joins cannot drop rows that the confirmed view would filter.
    return this.db.queryLive<Row>(
      `SELECT ${gasPaymentColumns(stream)}, ${q('event_cursor')}.${q('stream_cursor')} AS ${q(STREAM_CURSOR_COLUMN)} FROM (SELECT ${q('gas_payment_id')}, ${q('stream_cursor')} FROM ${q(GAS_PAYMENT_STREAM_CURSOR)} WHERE ${q('domain')} = $1 AND ${q('interchain_gas_paymaster')} = $2::bytea AND ${q('stream_cursor')} > $3::bigint AND ${q('stream_cursor')} <= $4::bigint ORDER BY ${q('stream_cursor')} ASC LIMIT $5) AS ${q('event_cursor')} INNER JOIN ${q(stream.table)} AS ${q('event_row')} ON ${q('event_row')}.${q('id')} = ${q('event_cursor')}.${q('gas_payment_id')}${gasPaymentMetadataJoins('LEFT JOIN')} ORDER BY ${q('event_cursor')}.${q('stream_cursor')} ASC`,
      [
        storedDomain(cursor.domain),
        cursor.address,
        after.toString(),
        through.toString(),
        config.EVENT_STREAM_BATCH_SIZE,
      ],
    );
  }

  private async gasPaymentCursorBounds(
    cursor: GasPaymentCursor,
  ): Promise<{ lastCursor: bigint; legacyMaxId: bigint }> {
    const [row] = await this.db.queryLive<{
      last_cursor: string;
      legacy_max_id: string;
    }>(
      `SELECT COALESCE(${q('legacy_max_id')}, 0)::text AS legacy_max_id, COALESCE(${q('last_cursor')}, 0)::text AS last_cursor FROM ${q(GAS_PAYMENT_STREAM_HEAD)} WHERE ${q('domain')} = $1 AND ${q('interchain_gas_paymaster')} = $2::bytea`,
      [storedDomain(cursor.domain), cursor.address],
    );
    return {
      lastCursor: parseId(row?.last_cursor ?? '0'),
      legacyMaxId: parseId(row?.legacy_max_id ?? '0'),
    };
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
          head.headHeight !== undefined &&
          head.indexedHeight !== undefined &&
          head.previousIndexedHeight !== undefined &&
          head.indexedHeight < head.previousIndexedHeight
        ) {
          this.rollbackCustomSubscribers(head);
        }
        if (
          head.headHeight !== undefined &&
          head.indexedHeight !== undefined &&
          this.hasCustomSubscriber(head.domain)
        ) {
          this.customHeads.set(head.domain, head);
          this.scheduleHeadDrain();
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
        this.scheduleHeadDrain();
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
        this.scheduleAgentDrain();
      }
    } catch (error) {
      this.logger.warn(
        `skipping invalid database notification: ${formatError(error)}`,
      );
      return;
    }
  }

  private scheduleAgentDrain(): void {
    if (!this.agentNotificationTimer && !this.drainingAgentNotifications) {
      this.agentNotificationTimer = setTimeout(() => {
        this.agentNotificationTimer = undefined;
        void this.drainAgentNotifications().catch((error) =>
          this.failAgentStream(error),
        );
      }, NOTIFICATION_BATCH_MS);
    }
  }

  private scheduleHeadDrain(delay = NOTIFICATION_BATCH_MS): void {
    if (!this.headNotificationTimer && !this.drainingHeadNotifications) {
      this.headNotificationTimer = setTimeout(() => {
        this.headNotificationTimer = undefined;
        void this.drainHeadNotifications().catch((error) => {
          this.logger.error(
            `frontier publication failed: ${formatError(error)}`,
          );
          this.scheduleHeadDrain(LISTENER_RETRY_MS);
        });
      }, delay);
    }
  }

  private scheduleExplorerDrain(): void {
    if (
      !this.explorerNotificationTimer &&
      !this.drainingExplorerNotifications
    ) {
      this.explorerNotificationTimer = setTimeout(() => {
        this.explorerNotificationTimer = undefined;
        void this.drainExplorerNotifications().catch((error) =>
          this.failExplorerStream(error),
        );
      }, NOTIFICATION_BATCH_MS);
    }
  }

  private queueExplorerNotification(messageId: string): void {
    if (!this.hasCanonicalExplorer()) return;
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
    this.scheduleExplorerDrain();
  }

  private async drainAgentNotifications(): Promise<void> {
    if (this.drainingAgentNotifications) return;
    this.drainingAgentNotifications = true;
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
      this.drainingAgentNotifications = false;
    }
  }

  private async drainHeadNotifications(): Promise<void> {
    if (this.drainingHeadNotifications) return;
    this.drainingHeadNotifications = true;
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
          if (failure.partialAgent) {
            this.logger.error(failure.message);
            this.failAgentDomain(domain, failure.original);
            if (failure.explorerAffected && this.explorerClients.size)
              this.failExplorerStream(failure.original);
            this.releaseHeadRange(domain, range);
            this.headFailures.delete(domain);
            continue;
          }
          const failures = (this.headFailures.get(domain) ?? 0) + 1;
          this.headFailures.set(domain, failures);
          this.logger.error(
            `frontier publication failed for domain ${domain} (${failures}/${MAX_HEAD_PUBLICATION_FAILURES}): ${formatError(error)}`,
          );
          if (failures >= MAX_HEAD_PUBLICATION_FAILURES) {
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
      for (const [domain, head] of this.customHeads) {
        try {
          await this.publishCustomHead(domain, head);
          if (this.customHeads.get(domain) === head)
            this.customHeads.delete(domain);
        } catch (error) {
          this.logger.error(
            `custom frontier publication failed for domain ${domain}: ${formatError(error)}`,
          );
          this.failCustomDomain(domain, error);
          this.customHeads.delete(domain);
        }
      }
    } finally {
      this.drainingHeadNotifications = false;
      if (this.headRanges.size || this.customHeads.size)
        this.scheduleHeadDrain(
          this.headFailures.size ? LISTENER_RETRY_MS : NOTIFICATION_BATCH_MS,
        );
    }
  }

  private async publishCustomHead(
    domain: number,
    head: HeadNotification,
  ): Promise<void> {
    if (head.headHeight === undefined || head.indexedHeight === undefined)
      return;
    const rollbackEpoch = this.rollbackEpochs.get(domain) ?? 0;
    const periods = new Set<number>();
    for (const client of this.clients.values()) {
      for (const subscription of client.subscriptions.values()) {
        if (
          subscription.confirmations !== undefined &&
          matchesDomain(subscription, domain)
        )
          periods.add(subscription.confirmations);
      }
    }
    for (const client of this.explorerClients.values()) {
      if (client.confirmations !== undefined && client.domains?.has(domain))
        periods.add(client.confirmations);
    }
    for (const period of periods) {
      const through = customFrontier(
        { head: head.headHeight, indexed: head.indexedHeight },
        period,
      );
      let after: bigint | undefined;
      for (const client of this.clients.values()) {
        for (const subscription of client.subscriptions.values()) {
          if (
            subscription.confirmations === period &&
            matchesDomain(subscription, domain)
          ) {
            const frontier = subscription.frontiers.get(domain);
            if (
              frontier !== undefined &&
              (after === undefined || frontier < after)
            )
              after = frontier;
          }
        }
      }
      if (after !== undefined && through > after) {
        for (const eventType of HEAD_PUBLICATION_ORDER) {
          if (!this.hasSubscriber({ domain, eventType, id: 0n }, period))
            continue;
          if (
            !(await this.publishCustomRange(
              domain,
              eventType,
              period,
              after,
              through,
              rollbackEpoch,
            ))
          )
            return;
        }
        for (const client of this.clients.values()) {
          for (const subscription of client.subscriptions.values()) {
            if (
              subscription.confirmations === period &&
              matchesDomain(subscription, domain)
            )
              subscription.frontiers.set(domain, through);
          }
        }
      }
      for (const [socket, client] of this.explorerClients) {
        if (client.confirmations !== period || !client.domains?.has(domain))
          continue;
        const explorerAfter = client.frontiers.get(domain);
        if (explorerAfter === undefined || through <= explorerAfter) continue;
        if (
          !(await this.publishCustomExplorerRange(
            socket,
            client,
            domain,
            explorerAfter,
            through,
            rollbackEpoch,
          ))
        )
          return;
        client.frontiers.set(domain, through);
      }
    }
  }

  private rollbackCustomSubscribers(head: HeadNotification): void {
    if (head.headHeight === undefined || head.indexedHeight === undefined)
      return;
    this.rollbackEpochs.set(
      head.domain,
      (this.rollbackEpochs.get(head.domain) ?? 0) + 1,
    );
    for (const [socket, client] of this.clients) {
      for (const [eventType, subscription] of client.subscriptions) {
        if (
          subscription.confirmations === undefined ||
          !matchesDomain(subscription, head.domain)
        )
          continue;
        const current = subscription.frontiers.get(head.domain);
        const previous = customFrontier(
          {
            head: head.headHeight,
            indexed: head.previousIndexedHeight ?? head.indexedHeight,
          },
          subscription.confirmations,
        );
        const from =
          current === undefined || previous > current ? previous : current;
        const to = customFrontier(
          { head: head.headHeight, indexed: head.indexedHeight },
          subscription.confirmations,
        );
        if (to >= from) continue;
        subscription.frontiers.set(head.domain, to);
        const keyPrefix = `${head.domain}:`;
        for (const key of subscription.sequences.keys()) {
          if (key.startsWith(keyPrefix)) subscription.sequences.delete(key);
        }
        this.send(socket, {
          confirmations: subscription.confirmations,
          domain: head.domain,
          eventType,
          fromHeight: from.toString(),
          toHeight: to.toString(),
          type: 'rollback',
        });
      }
    }
    for (const [socket, client] of this.explorerClients) {
      if (
        client.confirmations === undefined ||
        !client.domains?.has(head.domain)
      )
        continue;
      const current = client.frontiers.get(head.domain);
      const previous = customFrontier(
        {
          head: head.headHeight,
          indexed: head.previousIndexedHeight ?? head.indexedHeight,
        },
        client.confirmations,
      );
      const from =
        current === undefined || previous > current ? previous : current;
      const to = customFrontier(
        { head: head.headHeight, indexed: head.indexedHeight },
        client.confirmations,
      );
      if (to >= from) continue;
      client.frontiers.set(head.domain, to);
      this.enqueueExplorer(socket, client, [
        serialize({
          confirmations: client.confirmations,
          domain: head.domain,
          fromHeight: from.toString(),
          toHeight: to.toString(),
          type: 'rollback',
        }),
      ]);
    }
  }

  private async publishCustomRange(
    domain: number,
    eventType: EventType,
    confirmations: number,
    after: bigint,
    through: bigint,
    rollbackEpoch: number,
  ): Promise<boolean> {
    const stream = {
      ...STREAMS[eventType],
      table: CUSTOM_CONFIRMATION_TABLES[eventType],
    };
    const height = STREAM_HEIGHTS[eventType];
    const gasPaymentCursor =
      eventType === 'gas_payment'
        ? ` LEFT JOIN ${q(GAS_PAYMENT_STREAM_CURSOR)} AS ${q('event_cursor')} ON ${q('event_cursor')}.${q('gas_payment_id')} = ${q('event_row')}.${q('id')}`
        : '';
    const gasPaymentMetadata =
      eventType === 'gas_payment' ? gasPaymentMetadataJoins('LEFT JOIN') : '';
    const eventProjection =
      eventType === 'gas_payment'
        ? gasPaymentColumns(stream)
        : columns(stream, 'event_row');
    const cursorProjection =
      eventType === 'gas_payment'
        ? `, ${q('event_cursor')}.${q('stream_cursor')} AS ${q(STREAM_CURSOR_COLUMN)}`
        : '';
    let cursorHeight = after;
    let cursorId = 0n;
    while (true) {
      const rows = await this.db.queryLive<Row>(
        `SELECT ${eventProjection}${cursorProjection}, ${q('event_row')}.${q('id')} AS ${q(FRONTIER_ID)}, ${q('event_row')}.${q(height)} AS ${q(FRONTIER_HEIGHT)} FROM (SELECT * FROM ${q(stream.table)} AS ${q('frontier_row')} WHERE ${q('frontier_row')}.${q(stream.domain)}=$1 AND ${q('frontier_row')}.${q(height)}>$2::bigint AND ${q('frontier_row')}.${q(height)}<=$3::bigint AND (${q('frontier_row')}.${q(height)}>$4::bigint OR (${q('frontier_row')}.${q(height)}=$4::bigint AND ${q('frontier_row')}.${q('id')}>$5::bigint)) ORDER BY ${q('frontier_row')}.${q(height)}, ${q('frontier_row')}.${q('id')} LIMIT $6) AS ${q('event_row')}${gasPaymentMetadata}${gasPaymentCursor} ORDER BY ${q('event_row')}.${q(height)}, ${q('event_row')}.${q('id')}`,
        [
          storedDomain(domain),
          after.toString(),
          through.toString(),
          cursorHeight.toString(),
          cursorId.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
        ],
      );
      if (!rows.length)
        return (this.rollbackEpochs.get(domain) ?? 0) === rollbackEpoch;
      const last = rows.at(-1)!;
      cursorHeight = parseId(last[FRONTIER_HEIGHT]);
      cursorId = parseId(last[FRONTIER_ID]);
      // Custom gas streams cannot use durable cursors. Provisional payments do
      // not have one yet, so use the row ID only for internal ordering; it is
      // stripped from the event payload.
      const events = rows.map(
        ({
          [FRONTIER_ID]: _id,
          [FRONTIER_HEIGHT]: frontierHeight,
          ...event
        }) => ({
          event:
            eventType === 'gas_payment' && event[STREAM_CURSOR_COLUMN] == null
              ? { ...event, [STREAM_CURSOR_COLUMN]: _id }
              : event,
          height: parseId(frontierHeight),
        }),
      );
      events.sort((left, right) =>
        compareRows(eventType, left.event, right.event),
      );
      if ((this.rollbackEpochs.get(domain) ?? 0) !== rollbackEpoch)
        return false;
      events.forEach(({ event, height: eventHeight }) =>
        this.publish(eventType, event, confirmations, eventHeight),
      );
      if (rows.length < config.EVENT_STREAM_BATCH_SIZE) return true;
    }
  }

  private async publishCustomExplorerRange(
    socket: WebSocket,
    client: ExplorerClient,
    domain: number,
    after: bigint,
    through: bigint,
    rollbackEpoch: number,
  ): Promise<boolean> {
    let cursorHeight = after;
    let cursorSource = -1;
    let cursorId = 0n;
    while (true) {
      const changes = await this.db.queryLive<{
        changed_height: string;
        id: string;
        msg_id: string;
        source: number;
      }>(
        `/* custom_message_ids */ SELECT ${q('msg_id')}, ${q('changed_height')}, ${q('source')}, ${q('id')} FROM (
        SELECT ${q('msg_id')}, ${q('origin_block_height')} AS ${q('changed_height')}, 0 AS ${q('source')}, ${q('id')} FROM ${q('raw_message_dispatch')} WHERE ${q('origin_domain')}=$1 AND ${q('origin_block_height')}>$2::bigint AND ${q('origin_block_height')}<=$3::bigint
        UNION ALL
        SELECT ${q('msg_id')}, ${q('block_number')} AS ${q('changed_height')}, 1 AS ${q('source')}, ${q('id')} FROM ${q('delivered_message')} WHERE ${q('domain')}=$1 AND ${q('block_number')}>$2::bigint AND ${q('block_number')}<=$3::bigint
        UNION ALL
        SELECT ${q('msg_id')}, ${q('block_number')} AS ${q('changed_height')}, 2 AS ${q('source')}, ${q('id')} FROM ${q('gas_payment')} WHERE ${q('domain')}=$1 AND ${q('block_number')}>$2::bigint AND ${q('block_number')}<=$3::bigint
      ) AS ${q('changed_messages')}
      WHERE (${q('changed_height')}>$4::bigint OR (${q('changed_height')}=$4::bigint AND (${q('source')}>$5 OR (${q('source')}=$5 AND ${q('id')}>$6::bigint))))
      ORDER BY ${q('changed_height')}, ${q('source')}, ${q('id')} LIMIT $7`,
        [
          storedDomain(domain),
          after.toString(),
          through.toString(),
          cursorHeight.toString(),
          cursorSource,
          cursorId.toString(),
          config.EVENT_STREAM_BATCH_SIZE,
        ],
      );
      if (
        !changes.length ||
        this.explorerClients.get(socket) !== client ||
        (this.rollbackEpochs.get(domain) ?? 0) !== rollbackEpoch
      )
        return (this.rollbackEpochs.get(domain) ?? 0) === rollbackEpoch;
      const last = changes.at(-1)!;
      cursorHeight = parseId(last.changed_height);
      cursorSource = last.source;
      cursorId = parseId(last.id);
      const frontiers = [...client.frontiers];
      const rows = await this.db.queryLive<Row>(PROVISIONAL_MESSAGE_QUERY, [
        [...new Set(changes.map(({ msg_id }) => msg_id))],
        frontiers.map(([frontierDomain]) => storedDomain(frontierDomain)),
        frontiers.map(([, height]) => height.toString()),
        storedDomain(domain),
        through.toString(),
      ]);
      if (
        this.explorerClients.get(socket) !== client ||
        (this.rollbackEpochs.get(domain) ?? 0) !== rollbackEpoch
      )
        return false;
      const messages = rows.map((row) =>
        serialize({
          confirmations: client.confirmations,
          data: row,
          domain,
          height: through.toString(),
          type: 'message_upsert',
        }),
      );
      while (
        this.explorerClients.get(socket) === client &&
        client.queue.length + messages.length > MAX_EXPLORER_PENDING_MESSAGES
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, NOTIFICATION_BATCH_MS),
        );
        if ((this.rollbackEpochs.get(domain) ?? 0) !== rollbackEpoch)
          return false;
      }
      this.enqueueExplorer(socket, client, messages);
      if (changes.length < config.EVENT_STREAM_BATCH_SIZE) return true;
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
    let explorerPending = this.hasCanonicalExplorer();
    // Delivery and gas share message ids; queue each Explorer id once per range.
    const explorerIds = new Set<string>();
    for (const eventType of HEAD_PUBLICATION_ORDER) {
      const agentInterested = this.hasSubscriber({
        domain,
        eventType,
        id: 0n,
      });
      const explorerInterested =
        this.hasCanonicalExplorer() &&
        (eventType === 'delivery' || eventType === 'gas_payment');
      if (!agentInterested && !explorerInterested) continue;
      const stream = STREAMS[eventType];
      const height =
        eventType === 'dispatch' ? 'origin_block_height' : 'block_number';
      const gasPaymentCursor =
        eventType === 'gas_payment'
          ? ` LEFT JOIN ${q(GAS_PAYMENT_STREAM_CURSOR)} AS ${q('event_cursor')} ON ${q('event_cursor')}.${q('gas_payment_id')} = ${q('event_row')}.${q('id')}`
          : '';
      const gasPaymentMetadata =
        eventType === 'gas_payment' ? gasPaymentMetadataJoins('LEFT JOIN') : '';
      const eventProjection =
        eventType === 'gas_payment'
          ? gasPaymentColumns(stream)
          : columns(stream, 'event_row');
      const cursorProjection =
        eventType === 'gas_payment'
          ? `, ${q('event_cursor')}.${q('stream_cursor')} AS ${q(STREAM_CURSOR_COLUMN)}`
          : '';
      let cursorHeight = after;
      let cursorId = 0n;
      try {
        while (true) {
          const rows = await this.db.queryLive<Row>(
            `SELECT ${eventProjection}${cursorProjection}, ${q('event_row')}.${q('id')} AS ${q(FRONTIER_ID)}, ${q('event_row')}.${q(height)} AS ${q(FRONTIER_HEIGHT)} FROM (SELECT * FROM ${q(stream.table)} AS ${q('frontier_row')} WHERE ${q('frontier_row')}.${q(stream.domain)}=$1 AND ${q('frontier_row')}.${q(height)}>$2::bigint AND ${q('frontier_row')}.${q(height)}<=$3::bigint AND (${q('frontier_row')}.${q(height)}>$4::bigint OR (${q('frontier_row')}.${q(height)}=$4::bigint AND ${q('frontier_row')}.${q('id')}>$5::bigint)) ORDER BY ${q('frontier_row')}.${q(height)}, ${q('frontier_row')}.${q('id')} LIMIT $6) AS ${q('event_row')}${gasPaymentMetadata}${gasPaymentCursor} ORDER BY ${q('event_row')}.${q(height)}, ${q('event_row')}.${q('id')}`,
            [
              storedDomain(domain),
              after.toString(),
              through.toString(),
              cursorHeight.toString(),
              cursorId.toString(),
              config.EVENT_STREAM_BATCH_SIZE,
            ],
          );
          if (!rows.length) break;
          const lastByHeight = rows.at(-1)!;
          const nextHeight = parseId(lastByHeight[FRONTIER_HEIGHT]);
          const nextId = parseId(lastByHeight[FRONTIER_ID]);
          const events = rows.map(
            ({ [FRONTIER_ID]: _id, [FRONTIER_HEIGHT]: _height, ...event }) =>
              event,
          );
          events.sort((a, b) => compareRows(eventType, a, b));
          if (agentInterested) {
            agentPublished = true;
            events.forEach((row) => this.publish(eventType, row));
          }
          if (explorerInterested && this.hasCanonicalExplorer()) {
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
            batch.forEach((messageId) =>
              this.queueExplorerNotification(messageId),
            );
          }
          cursorHeight = nextHeight;
          cursorId = nextId;
          if (rows.length < config.EVENT_STREAM_BATCH_SIZE) break;
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
      this.hasCanonicalExplorer() &&
      this.explorerNotifications.size > limit
    ) {
      if (this.drainingExplorerNotifications) {
        await new Promise((resolve) =>
          setTimeout(resolve, NOTIFICATION_BATCH_MS),
        );
        continue;
      }
      clearTimeout(this.explorerNotificationTimer);
      this.explorerNotificationTimer = undefined;
      try {
        await this.drainExplorerNotifications();
      } catch (error) {
        // Explorer failures stay on the Explorer stream; agents keep publishing.
        this.failExplorerStream(error);
      }
    }
  }

  private async drainExplorerNotifications(): Promise<void> {
    if (this.drainingExplorerNotifications) return;
    this.drainingExplorerNotifications = true;
    try {
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
    } finally {
      this.drainingExplorerNotifications = false;
      if (this.explorerNotifications.size) this.scheduleExplorerDrain();
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
    const gasPaymentCursor =
      eventType === 'gas_payment'
        ? ` LEFT JOIN ${q(GAS_PAYMENT_STREAM_CURSOR)} AS ${q('event_cursor')} ON ${q('event_cursor')}.${q('gas_payment_id')} = ${q('event_row')}.${q('id')}`
        : '';
    const gasPaymentMetadata =
      eventType === 'gas_payment' ? gasPaymentMetadataJoins('LEFT JOIN') : '';
    const eventProjection =
      eventType === 'gas_payment'
        ? gasPaymentColumns(stream)
        : columns(stream, 'event_row');
    const cursorProjection =
      eventType === 'gas_payment'
        ? `, ${gasPaymentCursorExpression()} AS ${q(STREAM_CURSOR_COLUMN)}`
        : '';
    const rows = await this.db.queryLive<NotifiedRow>(
      `SELECT ${q('event_row')}.${q('id')} AS ${q('notification_id')}, ${eventProjection}${cursorProjection} FROM ${q(stream.table)} AS ${q('event_row')}${gasPaymentMetadata}${gasPaymentCursor} WHERE ${q('event_row')}.${q('id')} = ANY($1::bigint[]) ORDER BY ${q('event_row')}.${q('id')} ASC`,
      [[...expected.keys()]],
    );
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
    if (!this.hasCanonicalExplorer()) return;
    const rows = await this.db.queryLive<Row>(
      `SELECT ${tables.message_view.columns.map(q).join(', ')} FROM ${q('message_view')} WHERE ${q('msg_id')} = ANY($1::bytea[]) AND ${q('send_occurred_at')} IS NOT NULL`,
      [messageIds],
    );
    const messages = rows.map((row) =>
      serialize({ data: row, type: 'message_upsert' }),
    );
    for (const [socket, client] of this.explorerClients) {
      if (!client.canonical) continue;
      this.enqueueExplorer(socket, client, messages);
    }
  }

  private hasCanonicalExplorer(): boolean {
    return [...this.explorerClients.values()].some(
      ({ canonical }) => canonical,
    );
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

  private hasSubscriber(
    { domain, eventType }: EventNotification,
    confirmations?: number,
  ): boolean {
    for (const client of this.clients.values()) {
      const subscription = client.subscriptions.get(eventType);
      if (
        subscription &&
        subscription.confirmations === confirmations &&
        matchesDomain(subscription, domain)
      )
        return true;
    }
    return false;
  }

  private hasCustomSubscriber(domain: number): boolean {
    for (const client of this.clients.values()) {
      for (const subscription of client.subscriptions.values()) {
        if (
          subscription.confirmations !== undefined &&
          matchesDomain(subscription, domain)
        )
          return true;
      }
    }
    for (const client of this.explorerClients.values()) {
      if (client.confirmations !== undefined && client.domains?.has(domain))
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

  private failCustomDomain(domain: number, error: unknown): void {
    this.logger.error(
      `custom event stream failed for domain ${domain}: ${formatError(error)}`,
    );
    for (const [socket, client] of this.clients) {
      if (
        [...client.subscriptions.values()].some(
          (subscription) =>
            subscription.confirmations !== undefined &&
            matchesDomain(subscription, domain),
        )
      ) {
        this.disconnect(socket);
        socket.close(1013, 'Event stream read failed');
      }
    }
    for (const [socket, client] of this.explorerClients) {
      if (client.confirmations !== undefined && client.domains?.has(domain)) {
        this.disconnect(socket);
        socket.close(1013, 'Event stream read failed');
      }
    }
  }

  private failExplorerStream(error: unknown): void {
    this.logger.error(`Explorer event stream failed: ${formatError(error)}`);
    this.explorerNotifications.clear();
    for (const [socket, client] of this.explorerClients) {
      if (!client.canonical) continue;
      this.clearExplorerQueue(client);
      this.disconnect(socket);
      socket.close(1013, 'Event stream read failed');
    }
  }

  private closeClients(reason: string, code = 1013): void {
    this.closeAgentClients(reason, code);
    this.closeExplorerClients(reason, code);
  }

  private closeAgentClients(reason: string, code = 1013): void {
    this.notifications.clear();
    this.headRanges.clear();
    this.customHeads.clear();
    this.headFailures.clear();
    this.clients.forEach((_client, socket) => {
      this.cancelCatchUp(socket);
      socket.close(code, reason);
    });
    this.clients.clear();
  }

  private closeExplorerClients(reason: string, code = 1013): void {
    this.explorerNotifications.clear();
    this.explorerClients.forEach((client, socket) => {
      this.clearExplorerQueue(client);
      socket.close(code, reason);
    });
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

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
}

function serialize(message: Record<string, unknown>): SerializedMessage {
  // Explorer broadcasts share this payload; encode UTF-8 once for every recipient.
  return Buffer.from(JSON.stringify(message));
}

function subscriptionResponse(request: StreamRequest): Record<string, unknown> {
  return {
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
    confirmations: request.confirmations,
    streamCursorVersion: request.streamCursorVersion,
  };
}

function customFrontier(state: HeadState, confirmations: number): bigint {
  const delayed =
    state.head > BigInt(confirmations)
      ? state.head - BigInt(confirmations)
      : 0n;
  return delayed < state.indexed ? delayed : state.indexed;
}

function parseExplorerConfirmations(
  requestUrl: string | undefined,
): { confirmations: number; domains: Set<number> } | undefined {
  const query = new URL(requestUrl ?? MESSAGE_PATH, 'http://localhost')
    .searchParams;
  const rawConfirmations = query.get('confirmations');
  const rawDomains = query.get('domains');
  if (rawConfirmations === null && rawDomains === null) return undefined;
  if (!/^\d+$/.test(rawConfirmations ?? '')) {
    throw new Error('confirmations must be a non-negative integer');
  }
  const confirmations = Number(rawConfirmations);
  if (!isDomain(confirmations)) {
    throw new Error('confirmations must be a non-negative integer');
  }
  const domainValues = (rawDomains ?? '').split(',');
  const domains = new Set(domainValues.map((domain) => Number(domain)));
  if (
    !rawDomains ||
    !domains.size ||
    domainValues.some((domain) => !/^\d+$/.test(domain)) ||
    [...domains].some((domain) => !isDomain(domain))
  ) {
    throw new Error('confirmations requires comma-separated domains');
  }
  return { confirmations, domains };
}

function subscriptionStream(
  eventType: EventType,
  subscription: Subscription,
): Stream {
  const stream = STREAMS[eventType];
  return subscription.confirmations === undefined
    ? stream
    : { ...stream, table: CUSTOM_CONFIRMATION_TABLES[eventType] };
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

function columns(stream: Stream, relation?: string): string {
  return relation
    ? stream.columns.map((column) => `${q(relation)}.${q(column)}`).join(', ')
    : stream.projection;
}

export function gasPaymentColumns(stream: Stream): string {
  return [
    columns(stream, 'event_row'),
    `COALESCE(${q('event_row')}.${q('transaction_hash')}, ${q(GAS_PAYMENT_TRANSACTION)}.${q('hash')}) AS ${q('origin_tx_hash')}`,
    `COALESCE(${q('event_row')}.${q('block_hash')}, ${q(GAS_PAYMENT_BLOCK)}.${q('hash')}) AS ${q('origin_block_hash')}`,
    `COALESCE(${q('event_row')}.${q('block_number')}, ${q(GAS_PAYMENT_BLOCK)}.${q('height')}) AS ${q('origin_block_height')}`,
  ].join(', ');
}

export function gasPaymentMetadataJoins(join = 'INNER JOIN'): string {
  return ` ${join} ${q('transaction')} AS ${q(GAS_PAYMENT_TRANSACTION)} ON ${q(GAS_PAYMENT_TRANSACTION)}.${q('id')} = ${q('event_row')}.${q('tx_id')} ${join} ${q('block')} AS ${q(GAS_PAYMENT_BLOCK)} ON ${q(GAS_PAYMENT_BLOCK)}.${q('id')} = ${q(GAS_PAYMENT_TRANSACTION)}.${q('block_id')}`;
}

function gasPaymentCursorExpression(): string {
  return `COALESCE(${q('event_cursor')}.${q('stream_cursor')}, ${q('event_row')}.${q('id')})`;
}

function sequenceConfig(stream: Stream): NonNullable<Stream['sequence']> {
  if (!stream.sequence) throw new Error('Stream has no native sequence');
  return stream.sequence;
}

function rowDomain(row: Row, column: string): number {
  return parseDatabaseDomain(row[column], `Invalid ${column} in event row`);
}

function eventData(eventType: EventType, row: Row): Row {
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

function sequenceKey(domain: number, address: string): string {
  return `${domain}:${normalizeSequenceAddress(address)}`;
}

function rowCursorKey(
  eventType: EventType,
  domain: number,
  row: Row,
): string | undefined {
  const sequence = rowSequence(eventType, row);
  const streamCursor = gasPaymentStreamCursor(eventType, row);
  const cursor = sequence ?? streamCursor;
  return cursor && sequenceKey(domain, cursor.address);
}

function gasPaymentStreamCursor(
  eventType: EventType,
  row: Row,
): { address: string; value: bigint } | undefined {
  if (eventType !== 'gas_payment') return undefined;
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

function compareRows(eventType: EventType, a: Row, b: Row): number {
  const left =
    rowSequence(eventType, a)?.value ??
    gasPaymentStreamCursor(eventType, a)?.value;
  const right =
    rowSequence(eventType, b)?.value ??
    gasPaymentStreamCursor(eventType, b)?.value;
  return left === undefined || right === undefined || left === right
    ? 0
    : left < right
      ? -1
      : 1;
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
