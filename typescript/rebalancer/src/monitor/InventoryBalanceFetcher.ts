import { type Logger } from 'pino';

import { type ChainMap, type WarpCore } from '@hyperlane-xyz/sdk';

import { type InventoryMonitorConfig } from './Monitor.js';

export class InventoryBalanceFetcher {
  constructor(
    private readonly warpCore: WarpCore,
    private readonly inventoryConfig: InventoryMonitorConfig,
    private readonly logger: Logger,
  ) {}

  async fetchInventoryBalances(): Promise<ChainMap<bigint>> {
    const balances: ChainMap<bigint> = {};

    const readPromises = this.inventoryConfig.chains.map(async (chainName) => {
      const token = this.warpCore.tokens.find((t) => t.chainName === chainName);
      if (!token) {
        this.logger.warn(
          { chain: chainName },
          'No token found for inventory chain',
        );
        return { chainName, balance: 0n };
      }

      try {
        const address = this.inventoryConfig.inventoryAddresses[token.protocol];
        if (!address) {
          this.logger.warn(
            { chain: chainName, protocol: token.protocol },
            'No inventory address for chain protocol, skipping',
          );
          return { chainName, balance: 0n };
        }
        const adapter = token.getAdapter(this.warpCore.multiProvider);
        const balance = await adapter.getBalance(address);
        this.logger.debug(
          {
            chain: chainName,
            token: token.addressOrDenom,
            balance: balance.toString(),
          },
          'Read inventory balance',
        );
        return { chainName, balance };
      } catch (error) {
        this.logger.error(
          { chain: chainName, error: (error as Error).message },
          'Failed to read inventory balance',
        );
        return { chainName, balance: 0n };
      }
    });

    const results = await Promise.all(readPromises);

    for (const { chainName, balance } of results) {
      balances[chainName] = balance;
    }

    return balances;
  }
}
