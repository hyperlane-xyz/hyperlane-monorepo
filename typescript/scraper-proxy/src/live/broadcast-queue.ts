import type { WebSocket } from 'ws';
import { assert } from '@hyperlane-xyz/utils/validation';

type Client = { messages: Buffer[]; bytes: number; sending: boolean };

/** Independent bounded send queues. A subscriber never holds up publication. */
export class BroadcastQueue {
  private readonly clients = new Map<WebSocket, Client>();
  private bytes = 0;
  // Count shared buffers once globally, but every copy toward socket limits.
  private readonly refs = new Map<Buffer, number>();

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
    const incoming = new Set(messages);
    const added = () => {
      let total = 0;
      for (const message of incoming)
        if (!this.refs.has(message)) total += message.length;
      return total;
    };
    while (this.bytes + added() > this.limits.totalBytes) {
      let victim = socket;
      let largest = this.exclusiveBytes(client) + added();
      let hasExclusivePeer = false;
      let largestBacklog = client.bytes + bytes;
      let backlogPeer = socket;
      for (const [peer, queued] of this.clients) {
        if (peer === socket) continue;
        const held = this.exclusiveBytes(queued);
        if (held > 0) hasExclusivePeer = true;
        if (held > largest) {
          victim = peer;
          largest = held;
        }
        if (queued.bytes > largestBacklog) {
          backlogPeer = peer;
          largestBacklog = queued.bytes;
        }
      }
      // With only shared backlog, releasing a peer lets the next pass reclaim
      // its frames once their last queued reference is removed.
      if (victim === socket && !hasExclusivePeer) victim = backlogPeer;
      this.fail(victim);
      if (victim === socket) return false;
    }
    for (const message of messages) {
      const refs = this.refs.get(message) ?? 0;
      if (!refs) this.bytes += message.length;
      this.refs.set(message, refs + 1);
    }
    client.messages.push(...messages);
    client.bytes += bytes;
    if (!client.sending) void this.drain(socket, client);
    return true;
  }

  remove(socket: WebSocket) {
    const client = this.clients.get(socket);
    if (!client) return;
    for (const message of client.messages) this.release(message);
    client.bytes = 0;
    client.messages.length = 0;
    this.clients.delete(socket);
  }

  private fail(socket: WebSocket) {
    this.remove(socket);
    this.io.fail(socket);
  }

  private exclusiveBytes(client: Client): number {
    const copies = new Map<Buffer, number>();
    for (const message of client.messages)
      copies.set(message, (copies.get(message) ?? 0) + 1);
    let bytes = 0;
    for (const [message, count] of copies)
      if (this.refs.get(message) === count) bytes += message.length;
    return bytes;
  }

  private release(message: Buffer): void {
    const refs = this.refs.get(message) ?? 0;
    assert(refs > 0, 'Released a frame that was not queued');
    if (refs > 1) this.refs.set(message, refs - 1);
    else {
      this.refs.delete(message);
      this.bytes -= message.length;
    }
  }

  private async drain(socket: WebSocket, client: Client) {
    client.sending = true;
    try {
      while (this.clients.get(socket) === client) {
        const message = client.messages.shift();
        if (!message) return;
        this.release(message);
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
