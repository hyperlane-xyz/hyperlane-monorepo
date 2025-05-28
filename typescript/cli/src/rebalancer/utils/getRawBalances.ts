import { MonitorEvent } from '../interfaces/IMonitor.js';
import { RawBalances } from '../interfaces/IStrategy.js';

import { isCollateralizedTokenEligibleForRebalancing } from './isCollateralizedTokenEligibleForRebalancing.js';

export function getRawBalances(event: MonitorEvent): RawBalances {
  return event.tokensInfo.reduce((acc, tokenInfo) => {
    if (isCollateralizedTokenEligibleForRebalancing(tokenInfo.token)) {
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
