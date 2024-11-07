import { PopulatedTransaction, ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  TokenType,
  WarpCore,
  WarpCoreConfig,
  WarpCoreConfigSchema,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMerge, rootLogger } from '@hyperlane-xyz/utils';

import {
  DeployEnvironment,
  getRouterConfigsForAllVms,
} from '../../../src/config/environment.js';
import { fetchGCPSecret } from '../../../src/utils/gcloud.js';
import { startMetricsServer } from '../../../src/utils/metrics.js';
import { readYaml } from '../../../src/utils/utils.js';
import { getArgs } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import { WarpRouteBalance, XERC20Limit } from './types.js';
import { logger } from './utils.js';

export const metricsRegister = new Registry();

type WarpRouteMetricLabels = keyof WarpRouteMetrics;

interface WarpRouteMetrics {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  wallet_address: string;
  token_type: TokenType;
  warp_route_id: string;
  related_chain_names: string;
}

const warpRouteMetricLabels: WarpRouteMetricLabels[] = [
  'chain_name',
  'token_address',
  'token_name',
  'wallet_address',
  'token_type',
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
    // TODO better way ?
    token_address: token.collateralAddressOrDenom || token.addressOrDenom,
    token_name: token.name,
    // TODO better way?
    wallet_address: token.addressOrDenom,
    // TODO can we go standard => type?
    // @ts-ignore
    token_type: token.standard,
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
  if (balanceInfo.valueUSD) {
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.debug('Collateral value updated for chain', {
      chain: token.chainName,
      related_chain_names: metrics.related_chain_names,
      warp_route_id: metrics.warp_route_id,
      token: metrics.token_name,
      value: balanceInfo.valueUSD,
      token_type: token.standard,
    });
  }
  logger.debug('Wallet balance updated for chain', {
    chain: token.chainName,
    related_chain_names: metrics.related_chain_names,
    warp_route_id: metrics.warp_route_id,
    token: metrics.token_name,
    value: balanceInfo.balance,
    token_type: token.standard,
  });
}

export function updateXERC20LimitsMetrics(token: Token, limits: XERC20Limit) {
  const chain = token.chainName;
  xERC20LimitsGauge
    .labels({
      chain_name: chain,
      limit_type: 'mint',
      token_name: limits.tokenName,
    })
    .set(limits.mint);
  xERC20LimitsGauge
    .labels({
      chain_name: chain,
      limit_type: 'burn',
      token_name: limits.tokenName,
    })
    .set(limits.burn);
  xERC20LimitsGauge
    .labels({
      chain_name: chain,
      limit_type: 'mintMax',
      token_name: limits.tokenName,
    })
    .set(limits.mintMax);
  xERC20LimitsGauge
    .labels({
      chain_name: chain,
      limit_type: 'burnMax',
      token_name: limits.tokenName,
    })
    .set(limits.burnMax);
  logger.info('xERC20 limits updated for chain', {
    chain,
    limits,
  });
}
