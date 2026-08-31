import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';

void it('serves current usage and limits from /metrics', async () => {
  const {
    MetricsController,
    metricsRegistry,
    setDatabaseMetricsProvider,
    setWebSocketMetricsProvider,
  } = await import('./metrics.js');
  setDatabaseMetricsProvider(() => ({
    listeners: 1,
    pools: {
      live: { idle: 1, limit: 10, total: 2, waiting: 0 },
      main: { idle: 3, limit: 10, total: 5, waiting: 2 },
    },
  }));
  setWebSocketMetricsProvider(() => ({
    catchUps: 2,
    connections: { agent: 3, messages: 4 },
    explorerPendingBytes: 1_024,
    explorerPendingMessages: 9,
    maxExplorerPendingBytes: 512,
    maxExplorerPendingMessages: 5,
    messageClientIps: 2,
    messageMaxConnectionsPerIp: 3,
    limits: {
      agentConnections: 100,
      catchUpMs: 60_000,
      catchUpRows: 1_000,
      clientMessagesPerMinute: 30,
      concurrentCatchUps: 5,
      explorerPendingBytes: 16_777_216,
      explorerPendingMessages: 2_000,
      messageConnections: 400,
      messageConnectionsPerIp: 5,
      notificationEvents: 10_000,
      pendingEvents: 5_000,
      socketBufferedBytes: 1_024,
      totalPendingBytes: 4_096,
    },
    listenerReady: true,
    maxCatchUpDurationMs: 3_000,
    maxCatchUpRows: 500,
    maxClientBufferedBytes: 128,
    maxPendingCatchUpEvents: 5,
    notificationQueue: { agent: 6, messages: 7 },
    outboundPendingBytes: 256,
    pendingCatchUpEvents: 8,
    subscriptions: {
      delivery: { catchingUp: 0, live: 1 },
      dispatch: { catchingUp: 1, live: 2 },
      gas_payment: { catchingUp: 0, live: 0 },
      merkle_tree_insertion: { catchingUp: 1, live: 0 },
    },
  }));

  const output = await metricsRegistry.metrics();
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connections\{route="agent"\} 3/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_connection_limit\{route="messages"\} 400/,
  );
  assert.match(
    output,
    /hyperlane_scraper_proxy_websocket_subscriptions\{event_type="dispatch",state="catching_up"\} 1/,
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
  for (const outcome of [
    'aborted',
    'capacity_rejected',
    'failure',
    'success',
  ]) {
    assert.match(
      output,
      new RegExp(`websocket_catch_ups_total\\{outcome="${outcome}"\\} 0`),
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
  assert.match(output, /hyperlane_scraper_proxy_process_cpu/);

  @Module({ controllers: [MetricsController] })
  class MetricsTestModule {}
  const app = await NestFactory.create(MetricsTestModule, { logger: false });
  try {
    const server = await app.listen(0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type');
    assert(contentType?.includes('text/plain'));
    assert(contentType.includes('version=0.0.4'));
    assert(contentType.includes('charset=utf-8'));
    assert.match(
      await response.text(),
      /hyperlane_scraper_proxy_websocket_connections\{route="messages"\} 4/,
    );
  } finally {
    await app.close();
  }
});
