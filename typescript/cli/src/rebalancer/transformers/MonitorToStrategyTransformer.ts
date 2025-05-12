import { EvmHypCollateralAdapter, WarpCore } from '@hyperlane-xyz/sdk';

import { MonitorEvent } from '../interfaces/IMonitor.js';
import { RawBalances } from '../interfaces/IStrategy.js';
import { ITransformer } from '../interfaces/ITransformer.js';

export class MonitorToStrategyTransformer
  implements ITransformer<MonitorEvent, RawBalances>
{
  constructor(private readonly warpCore: WarpCore) {}

  transform(event: MonitorEvent): RawBalances {
    return event.tokensInfo.reduce((acc, tokenInfo) => {
      const provider = this.warpCore.multiProvider;
      const adapter = tokenInfo.token.getHypAdapter(provider);

      if (adapter instanceof EvmHypCollateralAdapter) {
        if (tokenInfo.bridgedSupply === undefined) {
          throw new Error(
            `bridgedSupply should not be undefined for collateralized token ${tokenInfo.token.addressOrDenom}`,
          );
        }

        acc[tokenInfo.token.chainName] = tokenInfo.bridgedSupply;
      }

      return acc;
    }, {} as RawBalances);
  }
}
