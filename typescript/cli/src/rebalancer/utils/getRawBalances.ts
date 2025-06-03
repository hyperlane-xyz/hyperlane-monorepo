import { ChainName } from '@hyperlane-xyz/sdk';

import { MonitorEvent } from '../interfaces/IMonitor.js';
import { RawBalances } from '../interfaces/IStrategy.js';
import { rebalancerLogger } from '../utils/logger.js';

import { isCollateralizedTokenEligibleForRebalancing } from './isCollateralizedTokenEligibleForRebalancing.js';

/**
 * Returns the raw balances required by the strategies from the monitor event
 * @param chains - The chains that should be included in the raw balances (e.g. the chains in the rebalancer config)
 * @param event - The monitor event to extract the raw balances from
 */
export function getRawBalances(
  chains: ChainName[],
  event: MonitorEvent,
): RawBalances {
  return event.tokensInfo.reduce((acc, tokenInfo) => {
    const { token, bridgedSupply } = tokenInfo;

    const chainSet = new Set(chains);

    // Ignore tokens that are not in the provided chains list
    if (!chainSet.has(token.chainName)) {
      rebalancerLogger.debug(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Skipping token: not in configured chains list',
      );
      return acc;
    }

    // Ignore tokens that are not collateralized
    if (!isCollateralizedTokenEligibleForRebalancing(token)) {
      rebalancerLogger.debug(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Skipping token: not collateralized or ineligible for rebalancing',
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
