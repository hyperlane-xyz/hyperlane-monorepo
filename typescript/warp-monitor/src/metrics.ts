import http from 'http';
import { Registry } from 'prom-client';

import { type ChainName, type Token, type WarpCore } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import {
  type NativeWalletBalance,
  type WarpMetricsGauges,
  type WarpRouteBalance,
  type XERC20Limit,
  createWarpMetricsGauges,
  startMetricsServer as sharedStartMetricsServer,
  updateManagedLockboxBalanceMetrics as sharedUpdateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics as sharedUpdateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics as sharedUpdateTokenBalanceMetrics,
  updateXERC20LimitsMetrics as sharedUpdateXERC20LimitsMetrics,
} from '@hyperlane-xyz/warp-metrics';

import { getLogger } from './utils.js';

export const metricsRegister = new Registry();

// Create shared gauges
const gauges: WarpMetricsGauges = createWarpMetricsGauges(metricsRegister);

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

/**
 * Start a simple HTTP server to host metrics. This just takes the registry and dumps the text
 * string to people who request `GET /metrics`.
 *
 * PROMETHEUS_PORT env var is used to determine what port to host on, defaults to 9090.
 */
export function startMetricsServer(register: Registry): http.Server {
  return sharedStartMetricsServer(register, getLogger());
}
