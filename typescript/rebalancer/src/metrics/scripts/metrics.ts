import { type Logger } from 'pino';
import { Counter, Registry } from 'prom-client';

import { type ChainName, type Token, type WarpCore } from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';
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
} from '@hyperlane-xyz/warp-metrics';

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
