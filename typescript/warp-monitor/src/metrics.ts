import { Gauge, Registry } from 'prom-client';

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
import type { Address } from '@hyperlane-xyz/utils';

import { getLogger } from './utils.js';

export const metricsRegister = new Registry();

// Create shared gauges
const gauges: WarpMetricsGauges = createWarpMetricsGauges(metricsRegister);

type BaseRouterMetric = {
  warpRouteId: string;
  nodeId: string;
  chainName: string;
  routerAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
};

type PendingDestinationMetric = BaseRouterMetric & {
  pendingAmount: number;
  pendingCount: number;
  oldestPendingSeconds: number;
};

type ProjectedDeficitMetric = BaseRouterMetric & {
  projectedDeficit: number;
};

type InventoryBalanceMetric = BaseRouterMetric & {
  inventoryAddress: string;
  inventoryBalance: number;
};

const pendingMetricLabelNames = [
  'warp_route_id',
  'node_id',
  'chain_name',
  'router_address',
  'token_address',
  'token_symbol',
  'token_name',
] as const;

const inventoryMetricLabelNames = [
  ...pendingMetricLabelNames,
  'inventory_address',
] as const;

const pendingDestinationAmountGauge = new Gauge({
  name: 'hyperlane_warp_route_pending_destination_amount',
  help: 'Undelivered pending transfer amount owed by destination router',
  registers: [metricsRegister],
  labelNames: pendingMetricLabelNames,
});

const pendingDestinationCountGauge = new Gauge({
  name: 'hyperlane_warp_route_pending_destination_count',
  help: 'Count of undelivered pending transfers for destination router',
  registers: [metricsRegister],
  labelNames: pendingMetricLabelNames,
});

const pendingDestinationOldestSecondsGauge = new Gauge({
  name: 'hyperlane_warp_route_pending_destination_oldest_seconds',
  help: 'Age in seconds of the oldest undelivered pending transfer for destination router',
  registers: [metricsRegister],
  labelNames: pendingMetricLabelNames,
});

const projectedDeficitGauge = new Gauge({
  name: 'hyperlane_warp_route_projected_deficit',
  help: 'Projected destination deficit = max(pending destination amount - router collateral, 0)',
  registers: [metricsRegister],
  labelNames: pendingMetricLabelNames,
});

const inventoryBalanceGauge = new Gauge({
  name: 'hyperlane_warp_route_inventory_balance',
  help: 'Inventory balance held by configured address for each route node',
  registers: [metricsRegister],
  labelNames: inventoryMetricLabelNames,
});

/**
 * Updates token balance metrics for a warp route token.
 */
export function updateTokenBalanceMetrics(
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
): void {
  sharedUpdateTokenBalanceMetrics(
    gauges,
    warpCore,
    token,
    balanceInfo,
    warpRouteId,
    getLogger(),
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
    getLogger(),
  );
}

/**
 * Updates native wallet balance metrics.
 */
export function updateNativeWalletBalanceMetrics(
  balance: NativeWalletBalance,
): void {
  sharedUpdateNativeWalletBalanceMetrics(gauges, balance, getLogger());
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
): void {
  sharedUpdateXERC20LimitsMetrics(
    gauges,
    token,
    limits,
    bridgeAddress,
    bridgeLabel,
    xERC20Address,
    getLogger(),
  );
}

export function resetPendingDestinationMetrics(): void {
  pendingDestinationAmountGauge.reset();
  pendingDestinationCountGauge.reset();
  pendingDestinationOldestSecondsGauge.reset();
  projectedDeficitGauge.reset();
}

export function resetInventoryBalanceMetrics(): void {
  inventoryBalanceGauge.reset();
}

export function updatePendingDestinationMetrics(
  metric: PendingDestinationMetric,
): void {
  const labels = {
    warp_route_id: metric.warpRouteId,
    node_id: metric.nodeId,
    chain_name: metric.chainName,
    router_address: metric.routerAddress,
    token_address: metric.tokenAddress,
    token_symbol: metric.tokenSymbol,
    token_name: metric.tokenName,
  };

  pendingDestinationAmountGauge.labels(labels).set(metric.pendingAmount);
  pendingDestinationCountGauge.labels(labels).set(metric.pendingCount);
  pendingDestinationOldestSecondsGauge
    .labels(labels)
    .set(metric.oldestPendingSeconds);
}

export function updateProjectedDeficitMetrics(
  metric: ProjectedDeficitMetric,
): void {
  const labels = {
    warp_route_id: metric.warpRouteId,
    node_id: metric.nodeId,
    chain_name: metric.chainName,
    router_address: metric.routerAddress,
    token_address: metric.tokenAddress,
    token_symbol: metric.tokenSymbol,
    token_name: metric.tokenName,
  };

  projectedDeficitGauge.labels(labels).set(metric.projectedDeficit);
}

export function updateInventoryBalanceMetrics(
  metric: InventoryBalanceMetric,
): void {
  const labels = {
    warp_route_id: metric.warpRouteId,
    node_id: metric.nodeId,
    chain_name: metric.chainName,
    router_address: metric.routerAddress,
    token_address: metric.tokenAddress,
    token_symbol: metric.tokenSymbol,
    token_name: metric.tokenName,
    inventory_address: metric.inventoryAddress,
  };

  inventoryBalanceGauge.labels(labels).set(metric.inventoryBalance);
}
