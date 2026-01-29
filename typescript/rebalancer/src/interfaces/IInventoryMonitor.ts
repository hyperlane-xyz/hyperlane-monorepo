import type { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Balance information for inventory on a specific chain.
 */
export interface InventoryBalance {
  chainName: ChainName;
  balance: bigint; // Current balance
  available: bigint; // Balance minus inflight movements
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
 * It accounts for inflight inventory movements when calculating available balance.
 */
export interface IInventoryMonitor {
  /**
   * Get current inventory balances across all monitored chains.
   */
  getBalances(): Promise<InventoryBalances>;

  /**
   * Get the available inventory balance on a specific chain.
   * Available = current balance - inflight outbound movements
   *
   * @param chain - Chain name to check
   * @returns Available balance, or 0n if chain is not monitored
   */
  getAvailableInventory(chain: ChainName): Promise<bigint>;

  /**
   * Get the total inflight inventory movements from a chain.
   * This is the sum of all pending inventory_movement actions originating from this chain.
   *
   * @param chain - Chain name to check
   * @returns Total inflight amount from this chain
   */
  getInflightFromChain(chain: ChainName): Promise<bigint>;

  /**
   * Refresh inventory balances from on-chain data.
   * Call this at the start of each rebalancing cycle.
   */
  refresh(): Promise<void>;
}
