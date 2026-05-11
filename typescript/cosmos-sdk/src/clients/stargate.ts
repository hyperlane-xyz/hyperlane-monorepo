import { StargateClient } from '@cosmjs/stargate';

import { rootLogger } from '@hyperlane-xyz/utils';

export function shouldCacheStargateClient(url: string): boolean {
  return !url.startsWith('ws://') && !url.startsWith('wss://');
}

export function disconnectStargateClient(
  client: Promise<StargateClient>,
): void {
  void client
    .then((stargateClient) => stargateClient.disconnect())
    .catch((error) => {
      rootLogger.debug({ error }, 'Failed to disconnect Stargate client');
    });
}

interface StargateClientCacheEntry {
  client: Promise<StargateClient>;
  evicted: boolean;
  leases: number;
}

export class StargateClientCache {
  private readonly clients = new Map<string, StargateClientCacheEntry>();
  private readonly entries = new Map<
    Promise<StargateClient>,
    StargateClientCacheEntry
  >();

  constructor(private readonly maxSize: number) {}

  get(url: string): Promise<StargateClient> {
    if (!shouldCacheStargateClient(url)) return StargateClient.connect(url);

    let entry = this.clients.get(url);
    if (!entry) {
      let pendingEntry: StargateClientCacheEntry;
      const client = StargateClient.connect(url).catch((error) => {
        const entry = pendingEntry;
        entry.evicted = true;
        if (this.clients.get(url) === entry) {
          this.clients.delete(url);
        }
        this.disconnectIfIdle(entry);
        throw error;
      });
      pendingEntry = { client, evicted: false, leases: 0 };
      entry = pendingEntry;
      this.entries.set(client, entry);
    } else {
      this.clients.delete(url);
    }
    entry.leases += 1;
    this.clients.set(url, entry);

    while (this.clients.size > this.maxSize) {
      const oldestUrl = this.clients.keys().next().value;
      if (!oldestUrl) break;
      this.evict(oldestUrl);
    }
    return entry.client;
  }

  evict(url: string, client?: Promise<StargateClient>): void {
    const entry = this.clients.get(url);
    if (!entry || (client && entry.client !== client)) return;

    this.clients.delete(url);
    entry.evicted = true;
    this.disconnectIfIdle(entry);
  }

  release(client: Promise<StargateClient>): void {
    const entry = this.entries.get(client);
    if (!entry) return;

    entry.leases -= 1;
    this.disconnectIfIdle(entry);
  }

  clear(): void {
    for (const entry of this.clients.values()) {
      entry.evicted = true;
      this.disconnectIfIdle(entry);
    }
    this.clients.clear();
  }

  private disconnectIfIdle(entry: StargateClientCacheEntry): void {
    if (!entry.evicted || entry.leases > 0) return;

    this.entries.delete(entry.client);
    disconnectStargateClient(entry.client);
  }
}
