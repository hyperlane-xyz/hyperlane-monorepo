import { type Logger } from 'pino';
import { Counter, Registry } from 'prom-client';

import {
  type NativeWalletBalance,
  type WarpMetricsGauges,
  type WarpRouteBalance,
  type XERC20Limit,
  createWarpMetricsGauges,
  updateManagedLockboxBalanceMetrics as sharedUpdateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics as sharedUpdateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics as sharedUpdateTokenBalanceMetrics,
  updateXERC20LimitsMetrics as sharedUpdateXERC20LimitsMetrics,
} from '@hyperlane-xyz/metrics';
import { type ChainName, type Token, type WarpCore } from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

export const metricsRegister = new Registry();

// Create shared warp metrics gauges
const gauges: WarpMetricsGauges = createWarpMetricsGauges(metricsRegister);

// Rebalancer-specific metrics
export const rebalancerExecutionTotal = new Counter({
  name: 'hyperlane_rebalancer_executions_total',
  help: 'Total number of rebalance execution attempts.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'succeeded'],
});

export const rebalancerExecutionAmount = new Counter({
  name: 'hyperlane_rebalancer_execution_amount',
  help: 'Total amount of tokens rebalanced.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'origin', 'destination', 'token'],
});

export const rebalancerPollingErrorsTotal = new Counter({
  name: 'hyperlane_rebalancer_polling_errors_total',
  help: 'Total number of errors during the monitor polling phase.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id'],
});

export const rebalancerIntentsCreatedTotal = new Counter({
  name: 'hyperlane_rebalancer_intents_created_total',
  help: 'Total number of rebalancing intents (routes) created.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'strategy', 'origin', 'destination'],
});

export const rebalancerActionsCreatedTotal = new Counter({
  name: 'hyperlane_rebalancer_actions_created_total',
  help: 'Total number of rebalancing actions (transactions) attempted.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'origin', 'destination', 'succeeded'],
});

/**
 * Updates token balance metrics for a warp route token.
 */
export function updateTokenBalanceMetrics(
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
  logger: Logger,
): void {
  sharedUpdateTokenBalanceMetrics(
    gauges,
    warpCore,
    token,
    balanceInfo,
    warpRouteId,
    logger,
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

  warpRouteTokenBalance.labels(metrics).set(balanceInfo.balance);
  logger.debug(
    {
      labels: metrics,
      balance: balanceInfo.balance,
    },
    'Wallet balance updated for token',
  );

  if (balanceInfo.valueUSD) {
    // TODO: consider deprecating this metric in favor of the value at risk metric
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.debug(
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

      warpRouteValueAtRisk.labels(labels).set(balanceInfo.valueUSD);
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
 */
export function updateManagedLockboxBalanceMetrics(
  warpCore: WarpCore,
  chainName: ChainName,
  tokenName: string,
  tokenAddress: string,
  lockBoxAddress: string,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
  logger: Logger,
): void {
  sharedUpdateManagedLockboxBalanceMetrics(
    gauges,
    warpCore,
    chainName,
    tokenName,
    tokenAddress,
    lockBoxAddress,
    balanceInfo,
    warpRouteId,
    logger,
  );
}

/**
 * Updates native wallet balance metrics.
 */
export function updateNativeWalletBalanceMetrics(
  balance: NativeWalletBalance,
  logger: Logger,
): void {
  sharedUpdateNativeWalletBalanceMetrics(gauges, balance, logger);
}

/**
 * Updates xERC20 limits metrics.
 */
export function updateXERC20LimitsMetrics(
  token: Token,
  limits: XERC20Limit,
  bridgeAddress: Address,
  bridgeLabel: string,
  xERC20Address: Address,
  logger: Logger,
): void {
  sharedUpdateXERC20LimitsMetrics(
    gauges,
    token,
    limits,
    bridgeAddress,
    bridgeLabel,
    xERC20Address,
    logger,
  );
}
