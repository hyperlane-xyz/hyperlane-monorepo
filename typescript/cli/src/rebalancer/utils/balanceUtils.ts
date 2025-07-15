import { Logger } from 'pino';

import { ChainName, Token } from '@hyperlane-xyz/sdk';

import { MonitorEvent } from '../interfaces/IMonitor.js';
import { RawBalances } from '../interfaces/IStrategy.js';

import { isCollateralizedTokenEligibleForRebalancing } from './tokenUtils.js';

/**
 * Returns the raw balances required by the strategies from the monitor event
 * @param chains - The chains that should be included in the raw balances (e.g. the chains in the rebalancer config)
 * @param event - The monitor event to extract the raw balances from
 * @returns An object mapping chain names to their raw balances.
 */
export function getRawBalances(
  chains: ChainName[],
  event: MonitorEvent,
  logger: Logger,
): RawBalances {
  const balances: RawBalances = {};
  const chainSet = new Set(chains);

  for (const tokenInfo of event.tokensInfo) {
    const { token, bridgedSupply } = tokenInfo;

    // Ignore tokens that are not in the provided chains list
    if (!chainSet.has(token.chainName)) {
      logger.info(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Skipping token: not in configured chains list',
      );
      continue;
    }

    // Ignore tokens that are not collateralized or are otherwise ineligible
    if (!isCollateralizedTokenEligibleForRebalancing(token)) {
      logger.info(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Skipping token: not collateralized or ineligible for rebalancing',
      );
      continue;
    }

    if (bridgedSupply === undefined) {
      throw new Error(
        `bridgedSupply should not be undefined for collateralized token ${token.addressOrDenom}`,
      );
    }

    balances[token.chainName] = bridgedSupply;
  }

  return balances;
}

export function formatBigInt(warpToken: Token, num: bigint): number {
  return warpToken.amount(num).getDecimalFormattedAmount();
}
