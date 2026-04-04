import { type Logger } from 'pino';
import { Counter, Gauge, Registry } from 'prom-client';

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

export const rebalancerInventoryBalance = new Gauge({
  name: 'hyperlane_rebalancer_inventory_balance',
  help: 'Current balance of inventory account per chain.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'chain', 'token_symbol', 'token_address'],
});

export const rebalancerCycleErrorsTotal = new Counter({
  name: 'hyperlane_rebalancer_cycle_errors_total',
  help: 'Total orchestrator-level errors per cycle (sync failures, execution crashes).',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'error_type'],
});

export const rebalancerTxFailuresTotal = new Counter({
  name: 'hyperlane_rebalancer_tx_failures_total',
  help: 'Total transaction-level failures (send, gas estimation, quote, populate, missing dispatch).',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'origin', 'destination', 'failure_reason'],
});

export const rebalancerBridgeFailuresTotal = new Counter({
  name: 'hyperlane_rebalancer_bridge_failures_total',
  help: 'Total external bridge failures (quote and execution).',
  registers: [metricsRegister],
  labelNames: [
    'warp_route_id',
    'source_chain',
    'target_chain',
    'failure_reason',
  ],
});

export const rebalancerInventoryBalanceFetchFailuresTotal = new Counter({
  name: 'hyperlane_rebalancer_inventory_balance_fetch_failures_total',
  help: 'Total failures when fetching inventory balances per chain.',
  registers: [metricsRegister],
  labelNames: ['warp_route_id', 'chain'],
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
