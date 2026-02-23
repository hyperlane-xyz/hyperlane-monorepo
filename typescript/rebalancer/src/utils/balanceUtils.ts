import { type Logger } from 'pino';

import { type ChainName } from '@hyperlane-xyz/sdk';

import { buildStrategyKey } from '../config/types.js';
import { type MonitorEvent } from '../interfaces/IMonitor.js';
import { type RawBalances } from '../interfaces/IStrategy.js';

import { isCollateralizedTokenEligibleForRebalancing } from './tokenUtils.js';

/**
 * Returns the raw balances required by the strategies from the monitor event.
 *
 * Strategy keys may be plain chain names ("chain1") or multi-asset keys ("USDC|chain1").
 * This function auto-detects the format and matches tokens accordingly.
 *
 * @param chains - The strategy keys that should be included (e.g. from getStrategyChainNames)
 * @param event - The monitor event to extract the raw balances from
 * @returns An object mapping strategy keys to their raw balances.
 */
export function getRawBalances(
  chains: ChainName[],
  event: MonitorEvent,
  logger: Logger,
): RawBalances {
  const balances: RawBalances = {};
  const chainSet = new Set(chains);

  // Detect multi-asset mode: keys contain "|"
  const isMultiAsset = chains.some((c) => c.includes('|'));

  for (const tokenInfo of event.tokensInfo) {
    const { token, bridgedSupply } = tokenInfo;

    // Determine the key for this token
    const key = isMultiAsset
      ? buildStrategyKey(token.symbol, token.chainName)
      : token.chainName;

    // Ignore tokens whose key is not in the provided chains list
    if (!chainSet.has(key)) {
      logger.debug(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
          key,
        },
        'Skipping token: not in configured chains list',
      );
      continue;
    }

    // Ignore tokens that are not collateralized or are otherwise ineligible
    if (!isCollateralizedTokenEligibleForRebalancing(token)) {
      logger.debug(
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

    balances[key] = bridgedSupply;
  }

  return balances;
}
