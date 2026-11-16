import assert from 'node:assert/strict';
import { it } from 'node:test';

import Fastify from 'fastify';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';

void it('serves current usage and limits from /metrics', async () => {
  const {
    metricsRegistry,
    setDatabaseMetricsProvider,
    setWebSocketMetricsProvider,
  } = await import('./metrics.js');
  setDatabaseMetricsProvider(() => ({
    listeners: 1,
    pools: {
      live: { idle: 1, limit: 10, total: 2, waiting: 0 },
      main: { idle: 3, limit: 10, total: 5, waiting: 2 },
      validator: { idle: 0, limit: 5, total: 5, waiting: 7 },
    },
  }));
  const validatorSubscriptions = [{ domain: 1, canonical: 1, custom: 1 }];
  setWebSocketMetricsProvider(() => ({
    connections: { agent: 3, messages: 4, validators: 2 },
    validatorPendingSetups: 1,
    validatorReservedConnections: 2,
    validatorSharedReaders: 1,
    validatorSubscriptions,
    validatorClientIps: 1,
    validatorMaxConnectionsPerIp: 2,
    explorerPendingBytes: 1_024,
    explorerPendingMessages: 9,
    maxExplorerPendingBytes: 512,
    maxExplorerPendingMessages: 5,
    messageClientIps: 2,
    messageMaxConnectionsPerIp: 3,
    limits: {
      agentConnections: 100,
      clientMessagesPerMinute: 30,
      explorerPendingBytes: 16_777_216,
      explorerPendingMessages: 2_000,
      messageConnections: 400,
      messageConnectionsPerIp: 5,
      validatorConnections: 500,
      validatorSetups: 32,
      validatorConnectionsPerIp: 5,
      validatorMessageBytes: 1024,
      notificationEvents: 10_000,
      socketBufferedBytes: 1_024,
      totalPendingBytes: 4_096,
    },
    listenerReady: true,
    maxClientBufferedBytes: 128,
    notificationQueue: { agent: 6, messages: 7 },
    outboundPendingBytes: 256,
    subscriptions: {
      delivery: 1,
      dispatch: 2,
      gas_payment: 0,
      merkle_tree_insertion: 0,
    },
  }));

  const output = await metricsRegistry.metrics();
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connections\{route="agent"\} 3/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connections\{route="validators"\} 2/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connection_limit\{route="validators"\} 500/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_pending_setups 1/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_subscriptions\{domain="1",policy="canonical"\} 1/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_subscriptions\{domain="1",policy="custom"\} 1/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_setup_limit 32/,
  );
  assert.match(output, /websocket_validator_reserved_connections 2/);
  assert.match(output, /websocket_validator_shared_readers 1/);
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_client_ips 1/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_max_connections_per_ip 2/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_validator_client_message_limit_bytes 1024/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connection_limit\{route="messages"\} 400/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_subscriptions\{event_type="dispatch"\} 2/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_outbound_pending_bytes 256/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_explorer_pending_messages 9/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_explorer_pending_bytes 1024/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_notification_queue_limit\{route="agent"\} 10000/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_send_failures_total\{reason="buffer_limit"\} 0/,
  );
  for (const reason of [
    'notification_queue_limit',
    'queue_limit',
    'send_error',
  ]) {
    assert.match(
      output,
      new RegExp(`websocket_send_failures_total\\{reason="${reason}"\\} 0`),
    );
  }
  for (const route of ['agent', 'messages']) {
    assert.match(
      output,
      new RegExp(
        `websocket_notification_queue_overflows_total\\{route="${route}"\\} 0`,
      ),
    );
    for (const reason of ['connection_limit', 'listener_unavailable']) {
      assert.match(
        output,
        new RegExp(
          `websocket_connection_rejections_total\\{(?=[^}]*route="${route}")(?=[^}]*reason="${reason}")[^}]*\\} 0`,
        ),
      );
    }
  }
  for (const reason of ['invalid_client_ip', 'per_ip_limit']) {
    assert.match(
      output,
      new RegExp(
        `websocket_connection_rejections_total\\{(?=[^}]*route="messages")(?=[^}]*reason="${reason}")[^}]*\\} 0`,
      ),
    );
  }
  assert.match(
    output,
    /hyperlane_scraper_proxy_database_pool_connections\{pool="main",state="active"\} 2/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_database_pool_waiting_requests\{pool="main"\} 2/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_database_pool_waiting_requests\{pool="validator"\} 7/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_database_pool_connection_limit\{pool="validator"\} 5/,
  );
  assert.match(output, /hyperlane_scraper_proxy_process_cpu/);

  validatorSubscriptions.length = 0;
  assert.doesNotMatch(
    await metricsRegistry.metrics(),
    /websocket_validator_subscriptions\{domain=/,
  );

  const { registerMetricsRoute } = await import('./module.js');
  const app = Fastify({ logger: false });
  registerMetricsRoute(app);
  try {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(response.statusCode, 200);
    const contentType = response.headers['content-type'];
    assert(contentType?.includes('text/plain'));
    assert(contentType.includes('version=0.0.4'));
    assert(contentType.includes('charset=utf-8'));
    assert.match(
      response.body,
      /hyperlane_scraper_proxy_websocket_connections\{route="messages"\} 4/,
    );
  } finally {
    await app.close();
  }
});
