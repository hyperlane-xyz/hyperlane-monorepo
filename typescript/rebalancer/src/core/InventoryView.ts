import type { ChainName } from '@hyperlane-xyz/sdk';

export interface IInventoryView {
  setBalances(balances: Record<ChainName, bigint>): void;
  getBalance(chain: ChainName): bigint;
  entries(): Iterable<[ChainName, bigint]>;
  getTotal(excludeChains: ChainName[]): bigint;
  beginCycle(): void;
  consume(chain: ChainName, amount: bigint): void;
  getConsumed(chain: ChainName): bigint;
  getEffectiveBalance(chain: ChainName): bigint;
}

export class LocalInventoryView implements IInventoryView {
  private inventoryBalances: Map<ChainName, bigint> = new Map();
  private consumedInventory: Map<ChainName, bigint> = new Map();

  setBalances(balances: Record<ChainName, bigint>): void {
    this.inventoryBalances = new Map(Object.entries(balances));
  }

  getBalance(chain: ChainName): bigint {
    return this.inventoryBalances.get(chain) ?? 0n;
  }

  entries(): Iterable<[ChainName, bigint]> {
    return this.inventoryBalances.entries();
  }

  getTotal(excludeChains: ChainName[]): bigint {
    const excludeSet = new Set(excludeChains);
    let total = 0n;
    for (const [chain, balance] of this.inventoryBalances) {
      if (!excludeSet.has(chain)) {
        total += balance;
      }
    }
    return total;
  }

  beginCycle(): void {
    this.consumedInventory.clear();
  }

  consume(chain: ChainName, amount: bigint): void {
    const current = this.consumedInventory.get(chain) ?? 0n;
    this.consumedInventory.set(chain, current + amount);
  }

  getConsumed(chain: ChainName): bigint {
    return this.consumedInventory.get(chain) ?? 0n;
  }

  getEffectiveBalance(chain: ChainName): bigint {
    const balance = this.getBalance(chain);
    const consumed = this.getConsumed(chain);
    return balance > consumed ? balance - consumed : 0n;
  }
}
