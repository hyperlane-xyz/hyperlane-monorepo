import { Gauge, type Registry } from 'prom-client';

import type {
  WarpRouteMetricLabels,
  WarpRouteValueAtRiskMetricLabels,
} from './types.js';

/**
 * Label names for warp route metrics.
 */
export const warpRouteMetricLabels: (keyof WarpRouteMetricLabels)[] = [
  'chain_name',
  'token_address',
  'token_name',
  'wallet_address',
  'token_standard',
  'warp_route_id',
  'related_chain_names',
];

/**
 * Label names for value at risk metrics.
 */
export const warpRouteValueAtRiskMetricLabels: (keyof WarpRouteValueAtRiskMetricLabels)[] =
  [
    'chain_name',
    'collateral_chain_name',
    'token_address',
    'token_name',
    'collateral_token_standard',
    'warp_route_id',
  ];

/**
 * Wallet balance metric label names.
 */
export const walletBalanceMetricLabels = [
  'chain',
  'wallet_address',
  'wallet_name',
  'token_address',
  'token_symbol',
  'token_name',
] as const;

/**
 * xERC20 limits metric label names.
 */
export const xERC20LimitsMetricLabels = [
  'chain_name',
  'limit_type',
  'token_name',
  'bridge_address',
  'token_address',
  'bridge_label',
] as const;

/**
 * Collection of warp route Prometheus gauges.
 */
export interface WarpMetricsGauges {
  warpRouteTokenBalance: Gauge<string>;
  warpRouteCollateralValue: Gauge<string>;
  warpRouteValueAtRisk: Gauge<string>;
  walletBalanceGauge: Gauge<string>;
  xERC20LimitsGauge: Gauge<string>;
}

/**
 * Creates a new wallet balance gauge with optional additional labels.
 */
export function createWalletBalanceGauge(
  registry: Registry,
  additionalLabels: string[] = [],
): Gauge<string> {
  return new Gauge({
    // Mirror the rust/main/ethers-prometheus `wallet_balance` gauge metric.
    name: 'hyperlane_wallet_balance',
    help: 'Current balance of a wallet for a token',
    registers: [registry],
    labelNames: [...walletBalanceMetricLabels, ...additionalLabels],
  });
}

/**
 * Creates all warp route metric gauges and registers them with the provided registry.
 *
 * @param registry - The Prometheus registry to register the gauges with
 * @param walletBalanceAdditionalLabels - Optional additional labels for the wallet balance gauge
 * @returns Collection of warp metric gauges
 */
export function createWarpMetricsGauges(
  registry: Registry,
  walletBalanceAdditionalLabels: string[] = [],
): WarpMetricsGauges {
  const warpRouteTokenBalance = new Gauge({
    name: 'hyperlane_warp_route_token_balance',
    help: 'HypERC20 token balance of a Warp Route',
    registers: [registry],
    labelNames: warpRouteMetricLabels,
  });

  const warpRouteCollateralValue = new Gauge({
    name: 'hyperlane_warp_route_collateral_value',
    help: 'Total value of collateral held in a HypERC20Collateral or HypNative contract of a Warp Route',
    registers: [registry],
    labelNames: warpRouteMetricLabels,
  });

  const warpRouteValueAtRisk = new Gauge({
    name: 'hyperlane_warp_route_value_at_risk',
    help: 'Value at risk on chain for a given Warp Route',
    registers: [registry],
    labelNames: warpRouteValueAtRiskMetricLabels,
  });

  const walletBalanceGauge = createWalletBalanceGauge(
    registry,
    walletBalanceAdditionalLabels,
  );

  const xERC20LimitsGauge = new Gauge({
    name: 'hyperlane_xerc20_limits',
    help: 'Current minting and burning limits of xERC20 tokens',
    registers: [registry],
    labelNames: xERC20LimitsMetricLabels,
  });

  return {
    warpRouteTokenBalance,
    warpRouteCollateralValue,
    warpRouteValueAtRisk,
    walletBalanceGauge,
    xERC20LimitsGauge,
  };
}
