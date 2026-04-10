import { type Logger } from 'pino';

import {
  normalizeScale,
  type ChainName,
  type NormalizedScale,
  type Token,
} from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import { type MonitorEvent } from '../interfaces/IMonitor.js';
import { type RawBalances } from '../interfaces/IStrategy.js';

import { isCollateralizedTokenEligibleForRebalancing } from './tokenUtils.js';

export function getTokenScale(token: Token): NormalizedScale {
  return normalizeScale(token.scale);
}

export function isIdentityScale(token: Token): boolean {
  const scale = getTokenScale(token);
  return scale.numerator === 1n && scale.denominator === 1n;
}

export function normalizeToCanonical(
  localAmount: bigint,
  tokenOrScale: Token | NormalizedScale,
): bigint {
  const scale =
    'numerator' in tokenOrScale && 'denominator' in tokenOrScale
      ? tokenOrScale
      : getTokenScale(tokenOrScale);
  return (localAmount * scale.numerator) / scale.denominator;
}

export function denormalizeToLocal(
  canonicalAmount: bigint,
  tokenOrScale: Token | NormalizedScale,
): bigint {
  const scale =
    'numerator' in tokenOrScale && 'denominator' in tokenOrScale
      ? tokenOrScale
      : getTokenScale(tokenOrScale);
  return (canonicalAmount * scale.denominator) / scale.numerator;
}

export function normalizeConfiguredAmount(
  amount: string | number,
  token: Token,
): bigint {
  return normalizeToCanonical(BigInt(toWei(amount, token.decimals)), token);
}

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
      logger.debug(
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

    const normalizedBalance = normalizeToCanonical(bridgedSupply, token);
    balances[token.chainName] = normalizedBalance;

    if (!isIdentityScale(token)) {
      logger.debug(
        {
          context: getRawBalances.name,
          chain: token.chainName,
          tokenSymbol: token.symbol,
          bridgedSupply: bridgedSupply.toString(),
          normalizedBalance: normalizedBalance.toString(),
          scale: getTokenScale(token),
        },
        'Normalized bridged supply to canonical units',
      );
    }
  }

  return balances;
}
