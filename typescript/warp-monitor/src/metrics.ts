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

export type PendingDestinationMetric = BaseRouterMetric & {
  pendingAmount: number;
  pendingCount: number;
  oldestPendingSeconds: number;
};

export type ProjectedDeficitMetric = BaseRouterMetric & {
  projectedDeficit: number;
};

export type InventoryBalanceMetric = BaseRouterMetric & {
  inventoryAddress: string;
  inventoryBalance: number;
};

type PendingMetricLabels = Record<
  (typeof pendingMetricLabelNames)[number],
  string
>;
type InventoryMetricLabels = Record<
  (typeof inventoryMetricLabelNames)[number],
  string
>;

// Per-route bookkeeping of the label sets each route last emitted. Lets a route
// atomically replace only its own series (remove old, write new) without a
// global reset that would wipe sibling routes' freshly-written data — the
// failure mode when many routes share one registry in the centralized monitor.
const lastPendingLabelsByRoute = new Map<string, PendingMetricLabels[]>();
const lastInventoryLabelsByRoute = new Map<string, InventoryMetricLabels[]>();

function toPendingLabels(metric: BaseRouterMetric): PendingMetricLabels {
  return {
    warp_route_id: metric.warpRouteId,
    node_id: metric.nodeId,
    chain_name: metric.chainName,
    router_address: metric.routerAddress,
    token_address: metric.tokenAddress,
    token_symbol: metric.tokenSymbol,
    token_name: metric.tokenName,
  };
}

function toInventoryLabels(
  metric: InventoryBalanceMetric,
): InventoryMetricLabels {
  return {
    ...toPendingLabels(metric),
    inventory_address: metric.inventoryAddress,
  };
}

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
  lastPendingLabelsByRoute.clear();
}

export function resetInventoryBalanceMetrics(): void {
  inventoryBalanceGauge.reset();
  lastInventoryLabelsByRoute.clear();
}

export function updatePendingDestinationMetrics(
  metric: PendingDestinationMetric,
): void {
  const labels = toPendingLabels(metric);
  pendingDestinationAmountGauge.labels(labels).set(metric.pendingAmount);
  pendingDestinationCountGauge.labels(labels).set(metric.pendingCount);
  pendingDestinationOldestSecondsGauge
    .labels(labels)
    .set(metric.oldestPendingSeconds);
}

export function updateProjectedDeficitMetrics(
  metric: ProjectedDeficitMetric,
): void {
  projectedDeficitGauge
    .labels(toPendingLabels(metric))
    .set(metric.projectedDeficit);
}

export function updateInventoryBalanceMetrics(
  metric: InventoryBalanceMetric,
): void {
  inventoryBalanceGauge
    .labels(toInventoryLabels(metric))
    .set(metric.inventoryBalance);
}

/**
 * Replace all pending-destination and projected-deficit series for a single
 * route in one shot: remove the route's previous series, then write the new
 * set. Sibling routes are untouched. Call this only when the pending data was
 * successfully collected — skipping the call on an explorer failure leaves the
 * route's prior series stale instead of publishing confident zeroes.
 */
export function replacePendingDestinationMetricsForRoute(
  warpRouteId: string,
  pending: PendingDestinationMetric[],
  projected: ProjectedDeficitMetric[],
): void {
  for (const labels of lastPendingLabelsByRoute.get(warpRouteId) ?? []) {
    pendingDestinationAmountGauge.remove(labels);
    pendingDestinationCountGauge.remove(labels);
    pendingDestinationOldestSecondsGauge.remove(labels);
    projectedDeficitGauge.remove(labels);
  }

  const emitted: PendingMetricLabels[] = [];
  for (const metric of pending) {
    updatePendingDestinationMetrics(metric);
    emitted.push(toPendingLabels(metric));
  }
  // Projected-deficit nodes are a subset of pending nodes (collateralized
  // only), so their labels are already covered by `emitted` for next cycle's
  // removal.
  for (const metric of projected) {
    updateProjectedDeficitMetrics(metric);
  }

  lastPendingLabelsByRoute.set(warpRouteId, emitted);
}

/**
 * Replace all inventory-balance series for a single route: remove the route's
 * previous series, then write the new set. Sibling routes are untouched.
 */
export function replaceInventoryBalanceMetricsForRoute(
  warpRouteId: string,
  inventory: InventoryBalanceMetric[],
): void {
  for (const labels of lastInventoryLabelsByRoute.get(warpRouteId) ?? []) {
    inventoryBalanceGauge.remove(labels);
  }

  const emitted: InventoryMetricLabels[] = [];
  for (const metric of inventory) {
    updateInventoryBalanceMetrics(metric);
    emitted.push(toInventoryLabels(metric));
  }

  lastInventoryLabelsByRoute.set(warpRouteId, emitted);
}
