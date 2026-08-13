import type { Server } from 'node:http';

import { Logger } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { DbService } from '../db/db.service.js';
import { ScraperDbService } from '../scraperdb/scraperdb.service.js';

const MESSAGE_CHANNEL = 'scraper_message_changed';
const WS_PATH = '/ws';
const MAX_MESSAGE_BYTES = 4_096;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
const DEBOUNCE_MS = 100;

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

export class MessageWebSocketServer {
  private readonly logger = new Logger(MessageWebSocketServer.name);
  private readonly scraperDb: ScraperDbService;
  private readonly subscriptionsByClient = new Map<WebSocket, Set<string>>();
  private readonly clientsByMessageId = new Map<string, Set<WebSocket>>();
  private readonly latestClients = new Set<WebSocket>();
  private readonly pendingMessageIds = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
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

    this.logger.log(`websocket server listening on ${WS_PATH}`);
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
    await this.stopListening?.();
    this.webSocketServer?.close();
  }

  private onConnection(socket: WebSocket): void {
    this.subscriptionsByClient.set(socket, new Set());
    this.send(socket, { type: 'ready' });

    socket.on('message', (data) => {
      this.onClientMessage(socket, rawDataToString(data));
    });
    socket.on('close', () => {
      this.removeClient(socket);
    });
    socket.on('error', (error) => {
      this.logger.warn(`websocket error: ${error.message}`);
      this.removeClient(socket);
    });
  }

  private onClientMessage(socket: WebSocket, raw: string): void {
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

  private subscribe(socket: WebSocket, messageId: string): void {
    const clientSubscriptions = this.subscriptionsByClient.get(socket);
    if (!clientSubscriptions) return;

    if (
      clientSubscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT &&
      !clientSubscriptions.has(messageId)
    ) {
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

  private unsubscribe(socket: WebSocket, messageId: string): void {
    this.subscriptionsByClient.get(socket)?.delete(messageId);
    const clients = this.clientsByMessageId.get(messageId);
    clients?.delete(socket);
    if (clients?.size === 0) this.clientsByMessageId.delete(messageId);
    this.send(socket, { msg_id: messageId, type: 'unsubscribed' });
  }

  private removeClient(socket: WebSocket): void {
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
    const messageId = parseNotificationPayload(payload);
    if (
      !messageId ||
      (!this.clientsByMessageId.has(messageId) && this.latestClients.size === 0)
    ) {
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
    socket: WebSocket,
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
    for (const socket of this.clientsByMessageId.get(messageId) ?? []) {
      this.send(socket, message);
    }
  }

  private broadcastLatest(message: Record<string, unknown>): void {
    for (const socket of this.latestClients) {
      this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(socket: WebSocket, error: string): void {
    this.send(socket, { error, type: 'error' });
  }
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
