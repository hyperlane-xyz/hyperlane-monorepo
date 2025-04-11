import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { WarpCore } from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { logTable } from '../logger.js';

export class HyperlaneRebalancer {
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly registry: IRegistry,
    private readonly warpRouteId: string,
    private readonly checkFrequency: number,
  ) {}

  async start(): Promise<void> {
    if (this.interval) {
      throw new Error('Rebalancer already running');
    }

    const chainMetadata = await this.registry.getMetadata();
    const chainAddresses = await this.registry.getAddresses();
    const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({
      mailbox,
    }));
    const multiProtocolProvider = new MultiProtocolProvider(
      objMerge(chainMetadata, mailboxes),
    );
    const warpCoreConfig = await this.registry.getWarpRoute(this.warpRouteId);
    const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);
    const collateralTokens = warpCore.tokens.filter((token) =>
      token.isCollateralized(),
    );

    this.interval = setInterval(async () => {
      const collaterals: {
        name: ChainName;
        collateral: number;
        symbol: string;
      }[] = [];

      for (const token of collateralTokens) {
        const adapter = token.getHypAdapter(multiProtocolProvider);
        const bridgedSupply = await adapter.getBridgedSupply();
        const collateral = token
          .amount(bridgedSupply!)
          .getDecimalFormattedAmount();
        collaterals.push({
          name: token.chainName,
          collateral,
          symbol: token.symbol,
        });
      }

      logTable(collaterals);
    }, this.checkFrequency);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
}
