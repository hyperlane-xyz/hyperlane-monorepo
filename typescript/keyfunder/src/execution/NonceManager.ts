import { ethers } from 'ethers';

export class NonceManager {
  // Key: `${chain}:${address.toLowerCase()}`
  private nonces: Map<string, number> = new Map();
  private locks: Map<string, Promise<any>> = new Map();

  private getKey(chain: string, address: string): string {
    return `${chain.toLowerCase()}:${address.toLowerCase()}`;
  }

  /**
   * Acquire mutex lock for a specific chain and address
   */
  public async withLock<T>(chain: string, address: string, fn: () => Promise<T>): Promise<T> {
    const key = this.getKey(chain, address);
    while (this.locks.has(key)) {
      try {
        await this.locks.get(key);
      } catch {
        // Ignore previous errors in the lock chain
      }
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(key, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      resolveLock();
    }
  }

  /**
   * Get the current nonce for an address on a chain, initializing from RPC if not cached
   */
  public async getNonce(chain: string, address: string, provider: ethers.Provider): Promise<number> {
    const key = this.getKey(chain, address);
    if (!this.nonces.has(key)) {
      const count = await provider.getTransactionCount(address, 'pending');
      this.nonces.set(key, count);
    }
    return this.nonces.get(key)!;
  }

  /**
   * Atomically get next nonce and increment internal counter
   */
  public async getAndIncrementNonce(
    chain: string,
    address: string,
    provider: ethers.Provider
  ): Promise<number> {
    return this.withLock(chain, address, async () => {
      const current = await this.getNonce(chain, address, provider);
      this.nonces.set(this.getKey(chain, address), current + 1);
      return current;
    });
  }

  /**
   * Manually set local nonce
   */
  public setNonce(chain: string, address: string, nonce: number): void {
    const key = this.getKey(chain, address);
    this.nonces.set(key, nonce);
  }

  /**
   * Resync local nonce from chain pending transaction count
   */
  public async resync(chain: string, address: string, provider: ethers.Provider): Promise<number> {
    return this.withLock(chain, address, async () => {
      const count = await provider.getTransactionCount(address, 'pending');
      this.nonces.set(this.getKey(chain, address), count);
      return count;
    });
  }

  /**
   * Reset nonces cache
   */
  public reset(chain?: string, address?: string): void {
    if (chain && address) {
      this.nonces.delete(this.getKey(chain, address));
    } else {
      this.nonces.clear();
    }
  }
}
