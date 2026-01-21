import type { Logger } from 'pino';

import type { ChainName, Token, WarpCore } from '@hyperlane-xyz/sdk';

import type {
  IInventoryMonitor,
  InventoryBalance,
  InventoryBalances,
} from '../interfaces/IInventoryMonitor.js';

/**
 * Configuration for the InventoryMonitor.
 */
export interface InventoryMonitorConfig {
  /** EOA address of the inventory signer (same key across all chains) */
  inventorySigner: string;
  /** Chain names that use inventory-based rebalancing */
  inventoryChains: ChainName[];
}

/**
 * Monitors inventory EOA balances across chains configured for inventory-based rebalancing.
 *
 * The InventoryMonitor:
 * - Reads token balances of the inventory signer EOA on each inventory chain
 * - Provides available inventory (equal to balance - on-chain state is source of truth)
 *
 * Note: Inflight tracking is no longer done here because on-chain balance already
 * reflects confirmed transactions. Within-cycle protection is provided by
 * consumedInventory in InventoryRebalancer, and cross-cycle protection is
 * provided by intent/action tracking in ActionTracker.
 *
 * Token addresses are obtained from the WarpCore tokens, which already know
 * which token is deployed on each chain.
 */
export class InventoryMonitor implements IInventoryMonitor {
  private readonly logger: Logger;
  private readonly config: InventoryMonitorConfig;
  private readonly warpCore: WarpCore;

  /** Cached balances from last refresh */
  private cachedBalances: InventoryBalances = new Map();

  constructor(
    config: InventoryMonitorConfig,
    warpCore: WarpCore,
    logger: Logger,
  ) {
    this.config = config;
    this.warpCore = warpCore;
    this.logger = logger;

    this.logger.info(
      {
        inventorySigner: config.inventorySigner,
        inventoryChains: config.inventoryChains,
      },
      'InventoryMonitor initialized',
    );
  }

  /**
   * Get the token for a specific chain from WarpCore.
   * Returns undefined if the chain doesn't have a token in the warp route.
   */
  private getTokenForChain(chainName: ChainName): Token | undefined {
    return this.warpCore.tokens.find((t) => t.chainName === chainName);
  }

  /**
   * Read the current balance of the inventory signer for a token.
   */
  private async readTokenBalance(token: Token): Promise<bigint> {
    try {
      // Get the token adapter which knows how to read balances
      const adapter = token.getAdapter(this.warpCore.multiProvider);
      const balance = await adapter.getBalance(this.config.inventorySigner);

      this.logger.debug(
        {
          chain: token.chainName,
          token: token.addressOrDenom,
          balance: balance.toString(),
        },
        'Read inventory balance',
      );

      return balance;
    } catch (error) {
      this.logger.error(
        {
          chain: token.chainName,
          token: token.addressOrDenom,
          error: (error as Error).message,
        },
        'Failed to read inventory balance',
      );
      return 0n;
    }
  }

  /**
   * Get current inventory balances across all monitored chains.
   * Returns cached values from last refresh() call.
   */
  async getBalances(): Promise<InventoryBalances> {
    return this.cachedBalances;
  }

  /**
   * Get the available inventory balance on a specific chain.
   * Available equals the on-chain balance (source of truth).
   *
   * @param chain - Chain name to check
   * @returns Available balance, or 0n if chain is not monitored
   */
  async getAvailableInventory(chain: ChainName): Promise<bigint> {
    const balance = this.cachedBalances.get(chain);
    if (!balance) {
      return 0n;
    }
    return balance.available;
  }

  /**
   * Refresh inventory balances from on-chain data.
   * Call this at the start of each rebalancing cycle.
   */
  async refresh(): Promise<void> {
    this.logger.debug('Refreshing inventory balances');

    const newBalances: InventoryBalances = new Map();

    // Read balances for each inventory chain in parallel
    const readPromises = this.config.inventoryChains.map(async (chainName) => {
      const token = this.getTokenForChain(chainName);
      if (!token) {
        this.logger.warn(
          { chain: chainName },
          'No token found for inventory chain, skipping',
        );
        return { chainName, balance: undefined };
      }

      const balance = await this.readTokenBalance(token);
      return { chainName, balance };
    });

    const results = await Promise.all(readPromises);

    // Set balances - available equals balance (on-chain state is source of truth)
    for (const { chainName, balance } of results) {
      if (balance === undefined) continue;

      const inventoryBalance: InventoryBalance = {
        chainName,
        balance,
        available: balance, // On-chain balance is the source of truth
      };

      newBalances.set(chainName, inventoryBalance);

      this.logger.debug(
        {
          chain: chainName,
          balance: balance.toString(),
          available: balance.toString(),
        },
        'Inventory balance updated',
      );
    }

    this.cachedBalances = newBalances;

    // Log per-chain balances for visibility
    const balancesByChain = Array.from(newBalances.entries()).map(
      ([chain, b]) => ({
        chain,
        balance: b.balance.toString(),
        balanceEth: (Number(b.balance) / 1e18).toFixed(6),
      }),
    );

    this.logger.info(
      {
        chainsMonitored: newBalances.size,
        balances: balancesByChain,
        totalBalance: Array.from(newBalances.values())
          .reduce((sum, b) => sum + b.balance, 0n)
          .toString(),
      },
      'Inventory balances refreshed',
    );
  }
}
