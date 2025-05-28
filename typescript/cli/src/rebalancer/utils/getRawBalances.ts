import { logDebug } from '../../logger.js';
import { Config } from '../config/Config.js';
import { MonitorEvent } from '../interfaces/IMonitor.js';
import { RawBalances } from '../interfaces/IStrategy.js';

import { isCollateralizedTokenEligibleForRebalancing } from './isCollateralizedTokenEligibleForRebalancing.js';

export function getRawBalances(
  config: Config,
  event: MonitorEvent,
): RawBalances {
  return event.tokensInfo.reduce((acc, tokenInfo) => {
    const { token, bridgedSupply } = tokenInfo;

    // Ignore tokens that are not in the rebalancer config
    if (!config.chains[token.chainName]) {
      logDebug(
        `[${getRawBalances.name}] Skipping token on chain ${token.chainName} that is not in config`,
      );
      return acc;
    }

    // Ignore tokens that are not collateralized
    if (!isCollateralizedTokenEligibleForRebalancing(token)) {
      logDebug(
        `[${getRawBalances.name}] Skipping token on chain ${token.chainName} that is not collateralized`,
      );
      return acc;
    }

    if (bridgedSupply === undefined) {
      throw new Error(
        `bridgedSupply should not be undefined for collateralized token ${token.addressOrDenom}`,
      );
    }

    acc[token.chainName] = bridgedSupply;

    return acc;
  }, {} as RawBalances);
}
