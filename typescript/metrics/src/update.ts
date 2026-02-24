import type { Logger } from 'pino';

import {
  type ChainName,
  type Token,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { type Address, isNullish } from '@hyperlane-xyz/utils';

import type { WarpMetricsGauges } from './gauges.js';
import type {
  NativeWalletBalance,
  WarpRouteBalance,
  WarpRouteMetricLabels,
  XERC20Limit,
} from './types.js';

/**
 * Updates token balance metrics for a warp route token.
 *
 * @param gauges - The warp metrics gauges to update
 * @param warpCore - The WarpCore instance for the route
 * @param token - The token to update metrics for
 * @param balanceInfo - The balance information for the token
 * @param warpRouteId - The warp route identifier
 * @param logger - The logger instance
 */
export function updateTokenBalanceMetrics(
  gauges: WarpMetricsGauges,
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
  logger: Logger,
): void {
  const allChains = warpCore.getTokenChains().sort();
  const relatedChains = allChains.filter(
    (chainName) => chainName !== token.chainName,
  );

  const metrics: WarpRouteMetricLabels = {
    chain_name: token.chainName,
    token_address: balanceInfo.tokenAddress,
    token_name: token.name,
    wallet_address:
      // the balance for an EvmHypERC20 token is returned as the total supply of the xERC20 token,
      // therefore we set the wallet address to the token address,
      // we follow the same pattern or synthetic tokens
      token.standard !== TokenStandard.EvmHypXERC20
        ? token.addressOrDenom
        : balanceInfo.tokenAddress,
    token_standard:
      // as we are reporting the total supply for clarity we report the standard as xERC20
      token.standard !== TokenStandard.EvmHypXERC20 ? token.standard : 'xERC20',
    warp_route_id: warpRouteId,
    // TODO: consider deprecating this label given that we have the value at risk metric
    related_chain_names: relatedChains.join(','),
  };

  gauges.warpRouteTokenBalance.labels({ ...metrics }).set(balanceInfo.balance);
  logger.info(
    {
      labels: metrics,
      balance: balanceInfo.balance,
    },
    'Wallet balance updated for token',
  );

  if (!isNullish(balanceInfo.valueUSD)) {
    // TODO: consider deprecating this metric in favor of the value at risk metric
    gauges.warpRouteCollateralValue
      .labels({ ...metrics })
      .set(balanceInfo.valueUSD);
    logger.info(
      {
        labels: metrics,
        valueUSD: balanceInfo.valueUSD,
      },
      'Wallet value updated for token',
    );

    for (const chainName of allChains) {
      const labels = {
        chain_name: chainName,
        collateral_chain_name: metrics.chain_name,
        token_address: metrics.token_address,
        token_name: metrics.token_name,
        collateral_token_standard: metrics.token_standard,
        warp_route_id: metrics.warp_route_id,
      };

      gauges.warpRouteValueAtRisk
        .labels({ ...labels })
        .set(balanceInfo.valueUSD);
      logger.info(
        {
          labels,
          valueUSD: balanceInfo.valueUSD,
        },
        `Value at risk on ${chainName} updated for token`,
      );
    }
  }
}

/**
 * Updates managed lockbox balance metrics.
 *
 * @param gauges - The warp metrics gauges to update
 * @param warpCore - The WarpCore instance for the route
 * @param chainName - The chain name where the lockbox is deployed
 * @param tokenName - The name of the collateral token
 * @param tokenAddress - The address of the collateral token
 * @param lockBoxAddress - The address of the managed lockbox
 * @param balanceInfo - The balance information for the lockbox
 * @param warpRouteId - The warp route identifier
 * @param logger - The logger instance
 */
export function updateManagedLockboxBalanceMetrics(
  gauges: WarpMetricsGauges,
  warpCore: WarpCore,
  chainName: ChainName,
  tokenName: string,
  tokenAddress: string,
  lockBoxAddress: string,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
  logger: Logger,
): void {
  const metrics: WarpRouteMetricLabels = {
    chain_name: chainName,
    token_address: tokenAddress,
    token_name: tokenName,
    wallet_address: lockBoxAddress,
    token_standard: 'EvmManagedLockbox', // TODO: we should eventually add a new TokenStandard for this
    warp_route_id: warpRouteId,
    related_chain_names: warpCore
      .getTokenChains()
      .filter((_chainName) => _chainName !== chainName)
      .sort()
      .join(','),
  };

  gauges.warpRouteTokenBalance.labels({ ...metrics }).set(balanceInfo.balance);
  logger.info(
    {
      labels: metrics,
      balance: balanceInfo.balance,
    },
    'ManagedLockbox collateral balance updated',
  );

  if (!isNullish(balanceInfo.valueUSD)) {
    gauges.warpRouteCollateralValue
      .labels({ ...metrics })
      .set(balanceInfo.valueUSD);
    logger.info(
      {
        labels: metrics,
        valueUSD: balanceInfo.valueUSD,
      },
      'ManagedLockbox value updated for token',
    );
  }
}

/**
 * Updates native wallet balance metrics.
 *
 * @param gauges - The warp metrics gauges to update
 * @param balance - The native wallet balance information
 * @param logger - The logger instance
 */
export function updateNativeWalletBalanceMetrics(
  gauges: WarpMetricsGauges,
  balance: NativeWalletBalance,
  logger: Logger,
): void {
  gauges.walletBalanceGauge
    .labels({
      chain: balance.chain,
      wallet_address: balance.walletAddress,
      wallet_name: balance.walletName,
      token_address: 'native',
      token_symbol: 'Native',
      token_name: 'Native',
    })
    .set(balance.balance);
  logger.info('Native wallet balance updated', {
    balanceInfo: balance,
  });
}

/**
 * Updates xERC20 limits metrics.
 *
 * @param gauges - The warp metrics gauges to update
 * @param token - The token to update metrics for
 * @param limits - The xERC20 limits
 * @param bridgeAddress - The address of the bridge
 * @param bridgeLabel - A label for the bridge (e.g., token standard)
 * @param xERC20Address - The address of the xERC20 token
 * @param logger - The logger instance
 */
export function updateXERC20LimitsMetrics(
  gauges: WarpMetricsGauges,
  token: Token,
  limits: XERC20Limit,
  bridgeAddress: Address,
  bridgeLabel: string,
  xERC20Address: Address,
  logger: Logger,
): void {
  const labels = {
    chain_name: token.chainName,
    token_name: token.name,
    bridge_address: bridgeAddress,
    token_address: xERC20Address,
    bridge_label: bridgeLabel,
  };

  for (const [limitType, limit] of Object.entries(limits)) {
    gauges.xERC20LimitsGauge
      .labels({
        ...labels,
        limit_type: limitType,
      })
      .set(limit);
  }

  logger.info(
    {
      ...labels,
      limits,
    },
    'xERC20 limits updated for bridge on token',
  );
}
