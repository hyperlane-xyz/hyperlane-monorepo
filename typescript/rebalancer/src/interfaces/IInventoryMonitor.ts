import type { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Balance information for inventory on a specific chain.
 */
export interface InventoryBalance {
  chainName: ChainName;
  balance: bigint; // Current on-chain balance
  available: bigint; // Available balance (equals on-chain balance - source of truth)
}

/**
 * Inventory balances across all monitored chains.
 */
export type InventoryBalances = Map<ChainName, InventoryBalance>;

/**
 * Interface for monitoring inventory EOA balances.
 *
 * The InventoryMonitor tracks the balance of the inventory signer EOA
 * across all chains configured for inventory-based rebalancing.
 * On-chain balance is the source of truth - no inflight deduction is needed
 * because confirmed transactions are already reflected in the balance.
 */
export interface IInventoryMonitor {
  /**
   * Get current inventory balances across all monitored chains.
   */
  getBalances(): Promise<InventoryBalances>;

  /**
   * Get the available inventory balance on a specific chain.
   * Available equals the on-chain balance (source of truth).
   *
   * @param chain - Chain name to check
   * @returns Available balance, or 0n if chain is not monitored
   */
  getAvailableInventory(chain: ChainName): Promise<bigint>;

  /**
   * Refresh inventory balances from on-chain data.
   * Call this at the start of each rebalancing cycle.
   */
  refresh(): Promise<void>;
}
