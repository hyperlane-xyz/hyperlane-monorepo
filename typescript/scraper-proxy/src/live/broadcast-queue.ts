import type { WebSocket } from 'ws';

type Client = { messages: Buffer[]; bytes: number; sending: boolean };

/** Independent bounded send queues. A subscriber never holds up publication. */
export class BroadcastQueue {
  private readonly clients = new Map<WebSocket, Client>();
  private bytes = 0;

  constructor(
    private readonly io: {
      send: (socket: WebSocket, message: Buffer) => Promise<boolean>;
      fail: (socket: WebSocket) => void;
    },
    private readonly limits: {
      messages: number;
      bytes: number;
      totalBytes: number;
    },
  ) {}

  metrics() {
    const clients = [...this.clients.values()];
    return {
      bytes: this.bytes,
      messages: clients.reduce(
        (total, client) => total + client.messages.length,
        0,
      ),
      maxBytes: Math.max(0, ...clients.map((client) => client.bytes)),
      maxMessages: Math.max(
        0,
        ...clients.map((client) => client.messages.length),
      ),
    };
  }

  busy(socket: WebSocket) {
    return this.clients.get(socket)?.sending ?? false;
  }

  enqueue(socket: WebSocket, messages: Buffer[]): boolean {
    let client = this.clients.get(socket);
    if (!client) {
      client = { messages: [], bytes: 0, sending: false };
      this.clients.set(socket, client);
    }
    const bytes = messages.reduce(
      (total, message) => total + message.length,
      0,
    );
    if (
      client.messages.length + messages.length > this.limits.messages ||
      client.bytes + bytes > this.limits.bytes
    ) {
      this.fail(socket);
      return false;
    }
    while (this.bytes + bytes > this.limits.totalBytes) {
      let victim = socket;
      let largest = client.bytes + bytes;
      for (const [peer, queued] of this.clients)
        if (peer !== socket && queued.bytes > largest) {
          victim = peer;
          largest = queued.bytes;
        }
      this.fail(victim);
      if (victim === socket) return false;
    }
    client.messages.push(...messages);
    client.bytes += bytes;
    this.bytes += bytes;
    if (!client.sending) void this.drain(socket, client);
    return true;
  }

  remove(socket: WebSocket) {
    const client = this.clients.get(socket);
    if (!client) return;
    this.bytes -= client.bytes;
    client.bytes = 0;
    client.messages.length = 0;
    this.clients.delete(socket);
  }

  private fail(socket: WebSocket) {
    this.remove(socket);
    this.io.fail(socket);
  }

  private async drain(socket: WebSocket, client: Client) {
    client.sending = true;
    try {
      while (this.clients.get(socket) === client) {
        const message = client.messages.shift();
        if (!message) return;
        this.bytes -= message.length;
        client.bytes -= message.length;
        if (!(await this.io.send(socket, message))) {
          this.remove(socket);
          return;
        }
      }
    } finally {
      client.sending = false;
    }
  }
}
