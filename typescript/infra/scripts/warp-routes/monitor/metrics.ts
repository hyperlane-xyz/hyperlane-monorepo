import { Gauge, Registry } from 'prom-client';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import { ChainName, Token, TokenStandard, WarpCore } from '@hyperlane-xyz/sdk';

import { WarpRouteBalance, XERC20Limit } from './types.js';
import { logger } from './utils.js';

export const metricsRegister = new Registry();

type WarpRouteMetricLabels = keyof WarpRouteMetrics;

interface WarpRouteMetrics {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  wallet_address: string;
  token_standard: TokenStandard;
  warp_route_id: string;
  related_chain_names: string;
}

const warpRouteMetricLabels: WarpRouteMetricLabels[] = [
  'chain_name',
  'token_address',
  'token_name',
  'wallet_address',
  'token_standard',
  'warp_route_id',
  'related_chain_names',
];

const warpRouteTokenBalance = new Gauge({
  name: 'hyperlane_warp_route_token_balance',
  help: 'HypERC20 token balance of a Warp Route',
  registers: [metricsRegister],
  labelNames: warpRouteMetricLabels,
});

const warpRouteCollateralValue = new Gauge({
  name: 'hyperlane_warp_route_collateral_value',
  help: 'Total value of collateral held in a HypERC20Collateral or HypNative contract of a Warp Route',
  registers: [metricsRegister],
  labelNames: warpRouteMetricLabels,
});

const xERC20LimitsGauge = new Gauge({
  name: 'hyperlane_xerc20_limits',
  help: 'Current minting and burning limits of xERC20 tokens',
  registers: [metricsRegister],
  labelNames: ['chain_name', 'limit_type', 'token_name'],
});

export function updateTokenBalanceMetrics(
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteBalance,
) {
  const metrics: WarpRouteMetrics = {
    chain_name: token.chainName,
    token_address: token.collateralAddressOrDenom || token.addressOrDenom,
    token_name: token.name,
    wallet_address: token.addressOrDenom,
    token_standard: token.standard,
    warp_route_id: createWarpRouteConfigId(
      token.symbol,
      warpCore.getTokenChains(),
    ),
    related_chain_names: warpCore
      .getTokenChains()
      .filter((chainName) => chainName !== token.chainName)
      .sort()
      .join(','),
  };

  warpRouteTokenBalance.labels(metrics).set(balanceInfo.balance);
  logger.info('Wallet balance updated for token', {
    labels: metrics,
    balance: balanceInfo.balance,
  });

  if (balanceInfo.valueUSD) {
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.info('Wallet balance updated for token', {
      labels: metrics,
      valueUSD: balanceInfo.valueUSD,
    });
  }
}

export function updateXERC20LimitsMetrics(token: Token, limits: XERC20Limit) {
  for (const [limitType, limit] of Object.entries(limits)) {
    xERC20LimitsGauge
      .labels({
        chain_name: token.chainName,
        limit_type: limitType,
        token_name: token.name,
      })
      .set(limit);
  }
  logger.info('xERC20 limits updated for chain', {
    chain: token.chainName,
    limits,
  });
}
