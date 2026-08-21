import { Controller, Get, Header } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import type { EventType } from './live/protocol.js';

const PREFIX = 'hyperlane_scraper_proxy_';

export type WebSocketMetricsSnapshot = {
  catchUps: number;
  connections: Record<'agent' | 'messages', number>;
  messageClientIps: number;
  messageMaxConnectionsPerIp: number;
  limits: {
    agentConnections: number;
    catchUpMs: number;
    catchUpRows: number;
    clientMessagesPerMinute: number;
    concurrentCatchUps: number;
    messageConnections: number;
    messageConnectionsPerIp: number;
    pendingEvents: number;
    socketBufferedBytes: number;
    totalPendingBytes: number;
  };
  listenerReady: boolean;
  maxCatchUpDurationMs: number;
  maxCatchUpRows: number;
  maxClientBufferedBytes: number;
  maxPendingCatchUpEvents: number;
  notificationQueue: Record<'agent' | 'messages', number>;
  outboundPendingBytes: number;
  pendingCatchUpEvents: number;
  subscriptions: Record<EventType, { catchingUp: number; live: number }>;
};

type DatabasePoolMetrics = {
  idle: number;
  limit: number;
  total: number;
  waiting: number;
};

export type DatabaseMetricsSnapshot = {
  listeners: number;
  pools: Record<'live' | 'main', DatabasePoolMetrics>;
};

export const metricsRegistry = new Registry();

collectDefaultMetrics({ prefix: PREFIX, register: metricsRegistry });

export const graphqlActiveRequests = new Gauge({
  help: 'Current number of active GraphQL requests.',
  name: `${PREFIX}graphql_active_requests`,
  registers: [metricsRegistry],
});

export const graphqlActiveRequestLimit = new Gauge({
  help: 'Maximum number of concurrent GraphQL requests.',
  name: `${PREFIX}graphql_active_request_limit`,
  registers: [metricsRegistry],
});

export const graphqlRequests = new Counter({
  help: 'GraphQL requests by outcome.',
  labelNames: ['outcome'] as const,
  name: `${PREFIX}graphql_requests_total`,
  registers: [metricsRegistry],
});

export const graphqlErrors = new Counter({
  help: 'GraphQL errors returned by Apollo.',
  name: `${PREFIX}graphql_errors_total`,
  registers: [metricsRegistry],
});

export const graphqlRequestDuration = new Histogram({
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
  help: 'GraphQL request duration in seconds.',
  name: `${PREFIX}graphql_request_duration_seconds`,
  registers: [metricsRegistry],
});

export const websocketConnections = new Counter({
  help: 'Accepted WebSocket connections by route.',
  labelNames: ['route'] as const,
  name: `${PREFIX}websocket_connections_total`,
  registers: [metricsRegistry],
});

export const websocketConnectionRejections = new Counter({
  help: 'Rejected WebSocket connections by route and reason.',
  labelNames: ['route', 'reason'] as const,
  name: `${PREFIX}websocket_connection_rejections_total`,
  registers: [metricsRegistry],
});

export const websocketCatchUps = new Counter({
  help: 'Historical WebSocket catch-ups by outcome.',
  labelNames: ['outcome'] as const,
  name: `${PREFIX}websocket_catch_ups_total`,
  registers: [metricsRegistry],
});

export const websocketClientMessageRejections = new Counter({
  help: 'Agent WebSocket messages rejected by the per-client rate limit.',
  name: `${PREFIX}websocket_client_message_rejections_total`,
  registers: [metricsRegistry],
});

export const websocketSendFailures = new Counter({
  help: 'WebSocket send failures by reason.',
  labelNames: ['reason'] as const,
  name: `${PREFIX}websocket_send_failures_total`,
  registers: [metricsRegistry],
});

let websocketMetricsProvider: (() => WebSocketMetricsSnapshot) | undefined;
let databaseMetricsProvider: (() => DatabaseMetricsSnapshot) | undefined;

export function setDatabaseMetricsProvider(
  provider: () => DatabaseMetricsSnapshot,
): void {
  databaseMetricsProvider = provider;
}

export function setWebSocketMetricsProvider(
  provider: () => WebSocketMetricsSnapshot,
): void {
  websocketMetricsProvider = provider;
}

function snapshotGauge(
  name: string,
  help: string,
  collect: (gauge: Gauge, snapshot: WebSocketMetricsSnapshot) => void,
  labelNames: string[] = [],
): void {
  new Gauge({
    collect() {
      this.reset();
      const snapshot = websocketMetricsProvider?.();
      if (snapshot) collect(this, snapshot);
    },
    help,
    labelNames,
    name: `${PREFIX}${name}`,
    registers: [metricsRegistry],
  });
}

function databaseSnapshotGauge(
  name: string,
  help: string,
  collect: (gauge: Gauge, snapshot: DatabaseMetricsSnapshot) => void,
  labelNames: string[] = [],
): void {
  new Gauge({
    collect() {
      this.reset();
      const snapshot = databaseMetricsProvider?.();
      if (snapshot) collect(this, snapshot);
    },
    help,
    labelNames,
    name: `${PREFIX}${name}`,
    registers: [metricsRegistry],
  });
}

databaseSnapshotGauge(
  'database_pool_connections',
  'Current database pool connections by pool and state.',
  (gauge, snapshot) => {
    for (const [pool, values] of Object.entries(snapshot.pools)) {
      gauge.set({ pool, state: 'active' }, values.total - values.idle);
      gauge.set({ pool, state: 'idle' }, values.idle);
    }
  },
  ['pool', 'state'],
);
databaseSnapshotGauge(
  'database_pool_connection_limit',
  'Maximum database connections by pool.',
  (gauge, snapshot) => {
    for (const [pool, values] of Object.entries(snapshot.pools))
      gauge.set({ pool }, values.limit);
  },
  ['pool'],
);
databaseSnapshotGauge(
  'database_pool_waiting_requests',
  'Current requests waiting for a database connection by pool.',
  (gauge, snapshot) => {
    for (const [pool, values] of Object.entries(snapshot.pools))
      gauge.set({ pool }, values.waiting);
  },
  ['pool'],
);
databaseSnapshotGauge(
  'database_listener_connections',
  'Current dedicated PostgreSQL listener connections.',
  (gauge, snapshot) => gauge.set(snapshot.listeners),
);

snapshotGauge(
  'websocket_connections',
  'Current WebSocket connections by route.',
  (gauge, snapshot) => {
    gauge.set({ route: 'agent' }, snapshot.connections.agent);
    gauge.set({ route: 'messages' }, snapshot.connections.messages);
  },
  ['route'],
);
snapshotGauge(
  'websocket_connection_limit',
  'Maximum WebSocket connections by route.',
  (gauge, snapshot) => {
    gauge.set({ route: 'agent' }, snapshot.limits.agentConnections);
    gauge.set({ route: 'messages' }, snapshot.limits.messageConnections);
  },
  ['route'],
);
snapshotGauge(
  'websocket_message_client_ips',
  'Current number of distinct /messages client IPs.',
  (gauge, snapshot) => gauge.set(snapshot.messageClientIps),
);
snapshotGauge(
  'websocket_message_connection_limit_per_ip',
  'Maximum /messages WebSocket connections per client IP.',
  (gauge, snapshot) => gauge.set(snapshot.limits.messageConnectionsPerIp),
);
snapshotGauge(
  'websocket_message_max_connections_per_ip',
  'Largest current /messages connection count for one client IP.',
  (gauge, snapshot) => gauge.set(snapshot.messageMaxConnectionsPerIp),
);
snapshotGauge(
  'websocket_listener_ready',
  'Whether the database event listener is ready.',
  (gauge, snapshot) => gauge.set(snapshot.listenerReady ? 1 : 0),
);
snapshotGauge(
  'websocket_catch_ups',
  'Current historical WebSocket catch-ups.',
  (gauge, snapshot) => gauge.set(snapshot.catchUps),
);
snapshotGauge(
  'websocket_catch_up_concurrency_limit',
  'Maximum concurrent historical WebSocket catch-ups.',
  (gauge, snapshot) => gauge.set(snapshot.limits.concurrentCatchUps),
);
snapshotGauge(
  'websocket_catch_up_row_limit',
  'Maximum rows delivered by one historical WebSocket catch-up.',
  (gauge, snapshot) => gauge.set(snapshot.limits.catchUpRows),
);
snapshotGauge(
  'websocket_max_catch_up_rows',
  'Largest current row count delivered by one historical catch-up.',
  (gauge, snapshot) => gauge.set(snapshot.maxCatchUpRows),
);
snapshotGauge(
  'websocket_catch_up_duration_limit_seconds',
  'Maximum duration of one historical WebSocket catch-up in seconds.',
  (gauge, snapshot) => gauge.set(snapshot.limits.catchUpMs / 1_000),
);
snapshotGauge(
  'websocket_max_catch_up_duration_seconds',
  'Longest current historical WebSocket catch-up duration in seconds.',
  (gauge, snapshot) => gauge.set(snapshot.maxCatchUpDurationMs / 1_000),
);
snapshotGauge(
  'websocket_pending_catch_up_events',
  'Current live events buffered behind historical catch-ups.',
  (gauge, snapshot) => gauge.set(snapshot.pendingCatchUpEvents),
);
snapshotGauge(
  'websocket_pending_catch_up_event_limit',
  'Maximum live events buffered behind one historical catch-up.',
  (gauge, snapshot) => gauge.set(snapshot.limits.pendingEvents),
);
snapshotGauge(
  'websocket_max_pending_catch_up_events',
  'Largest current live-event buffer behind one historical catch-up.',
  (gauge, snapshot) => gauge.set(snapshot.maxPendingCatchUpEvents),
);
snapshotGauge(
  'websocket_client_message_limit_per_minute',
  'Maximum agent messages accepted per client per minute.',
  (gauge, snapshot) => gauge.set(snapshot.limits.clientMessagesPerMinute),
);
snapshotGauge(
  'websocket_subscriptions',
  'Current agent subscriptions by event type and state.',
  (gauge, snapshot) => {
    for (const [eventType, subscriptions] of Object.entries(
      snapshot.subscriptions,
    )) {
      gauge.set(
        { event_type: eventType, state: 'catching_up' },
        subscriptions.catchingUp,
      );
      gauge.set({ event_type: eventType, state: 'live' }, subscriptions.live);
    }
  },
  ['event_type', 'state'],
);
snapshotGauge(
  'websocket_notification_queue',
  'Current queued database notifications by route.',
  (gauge, snapshot) => {
    gauge.set({ route: 'agent' }, snapshot.notificationQueue.agent);
    gauge.set({ route: 'messages' }, snapshot.notificationQueue.messages);
  },
  ['route'],
);
snapshotGauge(
  'websocket_outbound_pending_bytes',
  'Current bytes awaiting WebSocket send callbacks.',
  (gauge, snapshot) => gauge.set(snapshot.outboundPendingBytes),
);
snapshotGauge(
  'websocket_outbound_pending_byte_limit',
  'Maximum total bytes awaiting WebSocket send callbacks.',
  (gauge, snapshot) => gauge.set(snapshot.limits.totalPendingBytes),
);
snapshotGauge(
  'websocket_max_client_buffered_bytes',
  'Largest current ws bufferedAmount among connected clients.',
  (gauge, snapshot) => gauge.set(snapshot.maxClientBufferedBytes),
);
snapshotGauge(
  'websocket_client_buffered_byte_limit',
  'Maximum ws bufferedAmount allowed for one client.',
  (gauge, snapshot) => gauge.set(snapshot.limits.socketBufferedBytes),
);

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', metricsRegistry.contentType)
  getMetrics(): Promise<string> {
    return metricsRegistry.metrics();
  }
}
