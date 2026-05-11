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

export class StargateClientCache {
  private readonly clients = new Map<string, Promise<StargateClient>>();

  constructor(private readonly maxSize: number) {}

  get(url: string): Promise<StargateClient> {
    if (!shouldCacheStargateClient(url)) return StargateClient.connect(url);

    let client = this.clients.get(url);
    if (!client) {
      client = StargateClient.connect(url).catch((error) => {
        this.clients.delete(url);
        throw error;
      });
    } else {
      this.clients.delete(url);
    }
    this.clients.set(url, client);

    // LRU eviction can disconnect a shared client another caller just received;
    // callers evict and retry on estimate failure, and the cap is above normal
    // concurrent chain fanout.
    while (this.clients.size > this.maxSize) {
      const oldestUrl = this.clients.keys().next().value;
      if (!oldestUrl) break;
      this.evict(oldestUrl);
    }
    return client;
  }

  evict(url: string, client?: Promise<StargateClient>): void {
    const cachedClient = this.clients.get(url);
    if (!cachedClient || (client && cachedClient !== client)) return;

    this.clients.delete(url);
    disconnectStargateClient(cachedClient);
  }

  clear(): void {
    for (const client of this.clients.values()) {
      disconnectStargateClient(client);
    }
    this.clients.clear();
  }
}
