import type { Server } from 'node:http';

import { Logger } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { DbService } from '../db/db.service.js';
import { ScraperDbService } from '../scraperdb/scraperdb.service.js';

const MESSAGE_CHANNEL = 'scraper_message_changed';
const WS_PATH = '/ws';
const MAX_MESSAGE_BYTES = 4_096;
const MAX_CLIENTS = 1_000;
const MAX_LATEST_CLIENTS = 500;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 10;
const DEBOUNCE_MS = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STATS_INTERVAL_MS = 60_000;
const CLIENT_MESSAGE_RATE_LIMIT = 30;
const CLIENT_MESSAGE_RATE_WINDOW_MS = 60_000;

type ClientMessage =
  | {
      msg_id?: unknown;
      type: 'subscribe_message';
    }
  | {
      msg_id?: unknown;
      type: 'unsubscribe_message';
    }
  | {
      type: 'subscribe_latest';
    }
  | {
      type: 'unsubscribe_latest';
    }
  | {
      type: 'ping';
    };

type MessageRow = Record<string, unknown>;
type LiveWebSocket = WebSocket & {
  clientMessageCount?: number;
  clientMessageWindowStartedAt?: number;
  isAlive?: boolean;
};

export class MessageWebSocketServer {
  private readonly logger = new Logger(MessageWebSocketServer.name);
  private readonly scraperDb: ScraperDbService;
  private readonly subscriptionsByClient = new Map<
    LiveWebSocket,
    Set<string>
  >();
  private readonly clientsByMessageId = new Map<string, Set<LiveWebSocket>>();
  private readonly latestClients = new Set<LiveWebSocket>();
  private readonly pendingMessageIds = new Set<string>();
  private stats: WebSocketStats = emptyWebSocketStats();
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private stopListening?: () => Promise<void>;
  private webSocketServer?: WebSocketServer;

  constructor(private readonly db: DbService) {
    this.scraperDb = new ScraperDbService(db);
  }

  async start(server: Server): Promise<void> {
    this.webSocketServer = new WebSocketServer({
      maxPayload: MAX_MESSAGE_BYTES,
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
    this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);

    this.logger.log(
      `websocket server listening on ${WS_PATH} maxClients=${MAX_CLIENTS} maxLatestClients=${MAX_LATEST_CLIENTS} maxSubscriptionsPerClient=${MAX_SUBSCRIPTIONS_PER_CLIENT} clientMessageRateLimit=${CLIENT_MESSAGE_RATE_LIMIT}/${CLIENT_MESSAGE_RATE_WINDOW_MS}ms maxPayloadBytes=${MAX_MESSAGE_BYTES} heartbeatMs=${HEARTBEAT_INTERVAL_MS}`,
    );
    try {
      this.stopListening = await this.db.listen(MESSAGE_CHANNEL, (payload) => {
        this.onNotification(payload);
      });
    } catch (error) {
      this.logger.error(
        `failed to listen on ${MESSAGE_CHANNEL}: ${error instanceof Error ? error.message : String(error)}. Live message updates are disabled; set LISTEN_DATABASE_URL to the primary database if DATABASE_URL points at a read replica.`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    await this.stopListening?.();
    this.webSocketServer?.close();
  }

  private onConnection(socket: LiveWebSocket): void {
    if (this.subscriptionsByClient.size >= MAX_CLIENTS) {
      this.stats.rejectedMaxClients += 1;
      this.logger.warn(
        `rejecting websocket client: maxClients=${MAX_CLIENTS} activeClients=${this.subscriptionsByClient.size}`,
      );
      this.send(socket, {
        error: `Maximum websocket clients is ${MAX_CLIENTS}`,
        type: 'error',
      });
      socket.close(1013, 'Maximum websocket clients reached');
      return;
    }

    socket.isAlive = true;
    socket.clientMessageCount = 0;
    socket.clientMessageWindowStartedAt = Date.now();
    this.subscriptionsByClient.set(socket, new Set());
    this.stats.acceptedConnections += 1;
    this.send(socket, { type: 'ready' });

    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (data) => {
      this.onClientMessage(socket, rawDataToString(data));
    });
    socket.on('close', () => {
      this.stats.closedConnections += 1;
      this.removeClient(socket);
    });
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      this.removeClient(socket);
    });
  }

  private heartbeat(): void {
    for (const socket of this.subscriptionsByClient.keys()) {
      if (!socket.isAlive) {
        this.stats.staleTerminations += 1;
        this.logger.warn('terminating stale websocket client');
        this.removeClient(socket);
        socket.terminate();
        continue;
      }

      socket.isAlive = false;
      socket.ping();
    }
  }

  private logStats(): void {
    const stats = this.stats;
    this.stats = emptyWebSocketStats();
    this.logger.log(
      `websocket stats activeClients=${this.subscriptionsByClient.size} latestClients=${this.latestClients.size} messageSubscriptions=${this.messageSubscriptionCount()} trackedMessageIds=${this.clientsByMessageId.size} pendingMessageIds=${this.pendingMessageIds.size} accepted=${stats.acceptedConnections} closed=${stats.closedConnections} rejectedMaxClients=${stats.rejectedMaxClients} rejectedLatest=${stats.rejectedLatestClients} rejectedSubscriptionLimit=${stats.rejectedSubscriptionLimit} rejectedRateLimit=${stats.rejectedRateLimit} staleTerminations=${stats.staleTerminations} notifications=${stats.notifications} ignoredNotifications=${stats.ignoredNotifications} latestBroadcasts=${stats.latestBroadcasts} directBroadcasts=${stats.directBroadcasts} snapshotFailures=${stats.snapshotFailures}`,
    );
  }

  private onClientMessage(socket: LiveWebSocket, raw: string): void {
    if (!this.consumeClientMessageQuota(socket)) {
      this.stats.rejectedRateLimit += 1;
      this.logger.warn(
        `closing websocket client: messageRateLimit=${CLIENT_MESSAGE_RATE_LIMIT}/${CLIENT_MESSAGE_RATE_WINDOW_MS}ms`,
      );
      this.sendError(socket, 'Client message rate limit exceeded');
      socket.close(1008, 'Client message rate limit exceeded');
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendError(socket, 'Invalid JSON message');
      return;
    }

    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }

    if (message.type === 'subscribe_latest') {
      if (
        this.latestClients.size >= MAX_LATEST_CLIENTS &&
        !this.latestClients.has(socket)
      ) {
        this.stats.rejectedLatestClients += 1;
        this.logger.warn(
          `rejecting latest subscription: maxLatestClients=${MAX_LATEST_CLIENTS} latestClients=${this.latestClients.size}`,
        );
        this.sendError(
          socket,
          `Maximum latest subscriptions is ${MAX_LATEST_CLIENTS}`,
        );
        return;
      }

      this.latestClients.add(socket);
      this.send(socket, { type: 'subscribed_latest' });
      return;
    }

    if (message.type === 'unsubscribe_latest') {
      this.latestClients.delete(socket);
      this.send(socket, { type: 'unsubscribed_latest' });
      return;
    }

    if (
      message.type !== 'subscribe_message' &&
      message.type !== 'unsubscribe_message'
    ) {
      this.sendError(socket, 'Unsupported message type');
      return;
    }

    const messageId = normalizeMessageId(message.msg_id);
    if (!messageId) {
      this.sendError(socket, 'Invalid msg_id');
      return;
    }

    if (message.type === 'subscribe_message') {
      this.subscribe(socket, messageId);
      return;
    }

    this.unsubscribe(socket, messageId);
  }

  private subscribe(socket: LiveWebSocket, messageId: string): void {
    const clientSubscriptions = this.subscriptionsByClient.get(socket);
    if (!clientSubscriptions) return;

    if (
      clientSubscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT &&
      !clientSubscriptions.has(messageId)
    ) {
      this.stats.rejectedSubscriptionLimit += 1;
      this.logger.warn(
        `rejecting message subscription: maxSubscriptionsPerClient=${MAX_SUBSCRIPTIONS_PER_CLIENT}`,
      );
      this.sendError(
        socket,
        `Maximum subscriptions per client is ${MAX_SUBSCRIPTIONS_PER_CLIENT}`,
      );
      return;
    }

    clientSubscriptions.add(messageId);
    const clients = this.clientsByMessageId.get(messageId) ?? new Set();
    clients.add(socket);
    this.clientsByMessageId.set(messageId, clients);
    this.send(socket, { msg_id: messageId, type: 'subscribed' });
    void this.sendMessageSnapshot(socket, messageId);
  }

  private unsubscribe(socket: LiveWebSocket, messageId: string): void {
    this.subscriptionsByClient.get(socket)?.delete(messageId);
    const clients = this.clientsByMessageId.get(messageId);
    clients?.delete(socket);
    if (clients?.size === 0) this.clientsByMessageId.delete(messageId);
    this.send(socket, { msg_id: messageId, type: 'unsubscribed' });
  }

  private removeClient(socket: LiveWebSocket): void {
    const clientSubscriptions = this.subscriptionsByClient.get(socket);
    if (!clientSubscriptions) return;

    for (const messageId of clientSubscriptions) {
      const clients = this.clientsByMessageId.get(messageId);
      clients?.delete(socket);
      if (clients?.size === 0) this.clientsByMessageId.delete(messageId);
    }
    this.subscriptionsByClient.delete(socket);
    this.latestClients.delete(socket);
  }

  private onNotification(payload: string | undefined): void {
    this.stats.notifications += 1;
    const messageId = parseNotificationPayload(payload);
    if (
      !messageId ||
      (!this.clientsByMessageId.has(messageId) && this.latestClients.size === 0)
    ) {
      this.stats.ignoredNotifications += 1;
      return;
    }

    this.pendingMessageIds.add(messageId);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingMessages();
    }, DEBOUNCE_MS);
  }

  private async flushPendingMessages(): Promise<void> {
    const messageIds = [...this.pendingMessageIds];
    this.pendingMessageIds.clear();

    await Promise.all(
      messageIds.map(async (messageId) => {
        const message = await this.fetchMessage(messageId);
        this.broadcast(messageId, {
          message,
          msg_id: messageId,
          type: 'message_updated',
        });
        this.broadcastLatest({
          message,
          msg_id: messageId,
          type: 'latest_message_updated',
        });
      }),
    );
  }

  private async sendMessageSnapshot(
    socket: LiveWebSocket,
    messageId: string,
  ): Promise<void> {
    try {
      const message = await this.fetchMessage(messageId);
      this.send(socket, {
        message,
        msg_id: messageId,
        type: 'message_snapshot',
      });
    } catch (error) {
      this.stats.snapshotFailures += 1;
      this.logger.warn(
        `failed to fetch message snapshot ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.sendError(socket, 'Failed to fetch message snapshot');
    }
  }

  private async fetchMessage(messageId: string): Promise<MessageRow | null> {
    const [message] = await this.scraperDb.select('message_view', {
      limit: 1,
      where: { msg_id: { _eq: messageId } },
    });
    return message ?? null;
  }

  private broadcast(messageId: string, message: Record<string, unknown>): void {
    const sockets = this.clientsByMessageId.get(messageId) ?? new Set();
    this.stats.directBroadcasts += sockets.size;
    for (const socket of sockets) {
      this.send(socket, message);
    }
  }

  private broadcastLatest(message: Record<string, unknown>): void {
    this.stats.latestBroadcasts += this.latestClients.size;
    for (const socket of this.latestClients) {
      this.send(socket, message);
    }
  }

  private messageSubscriptionCount(): number {
    let count = 0;
    for (const subscriptions of this.subscriptionsByClient.values()) {
      count += subscriptions.size;
    }
    return count;
  }

  private send(socket: LiveWebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(socket: LiveWebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }

  private consumeClientMessageQuota(socket: LiveWebSocket): boolean {
    const now = Date.now();
    const windowStartedAt = socket.clientMessageWindowStartedAt ?? now;
    if (now - windowStartedAt >= CLIENT_MESSAGE_RATE_WINDOW_MS) {
      socket.clientMessageWindowStartedAt = now;
      socket.clientMessageCount = 1;
      return true;
    }

    const nextCount = (socket.clientMessageCount ?? 0) + 1;
    socket.clientMessageCount = nextCount;
    return nextCount <= CLIENT_MESSAGE_RATE_LIMIT;
  }
}

type WebSocketStats = {
  acceptedConnections: number;
  closedConnections: number;
  directBroadcasts: number;
  ignoredNotifications: number;
  latestBroadcasts: number;
  notifications: number;
  rejectedLatestClients: number;
  rejectedMaxClients: number;
  rejectedRateLimit: number;
  rejectedSubscriptionLimit: number;
  snapshotFailures: number;
  staleTerminations: number;
};

function emptyWebSocketStats(): WebSocketStats {
  return {
    acceptedConnections: 0,
    closedConnections: 0,
    directBroadcasts: 0,
    ignoredNotifications: 0,
    latestBroadcasts: 0,
    notifications: 0,
    rejectedLatestClients: 0,
    rejectedMaxClients: 0,
    rejectedRateLimit: 0,
    rejectedSubscriptionLimit: 0,
    snapshotFailures: 0,
    staleTerminations: 0,
  };
}

function parseNotificationPayload(payload: string | undefined): string | null {
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as { msg_id?: unknown };
    return normalizeMessageId(parsed.msg_id);
  } catch {
    return null;
  }
}

function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/^0x/i, '\\x').toLowerCase();
  return /^\\x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
