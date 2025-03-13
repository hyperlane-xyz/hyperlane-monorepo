import { Gauge, Registry } from 'prom-client';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import { ChainName, Token, TokenStandard, WarpCore } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getWalletBalanceGauge } from '../../../src/utils/metrics.js';

import { NativeWalletBalance, WarpRouteBalance, XERC20Limit } from './types.js';
import { logger } from './utils.js';

export const metricsRegister = new Registry();

type WarpRouteMetricLabels = keyof WarpRouteMetrics;

interface WarpRouteMetrics {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  wallet_address: string;
  token_standard: TokenStandard | 'EvmManagedLockbox' | 'xERC20';
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

const walletBalanceGauge = getWalletBalanceGauge(metricsRegister);

const xERC20LimitsGauge = new Gauge({
  name: 'hyperlane_xerc20_limits',
  help: 'Current minting and burning limits of xERC20 tokens',
  registers: [metricsRegister],
  labelNames: [
    'chain_name',
    'limit_type',
    'token_name',
    'bridge_address',
    'token_address',
    'bridge_label',
  ],
});

export function updateTokenBalanceMetrics(
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteBalance,
  collateralTokenSymbol: string,
) {
  const metrics: WarpRouteMetrics = {
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
    warp_route_id: createWarpRouteConfigId(
      collateralTokenSymbol,
      warpCore.getTokenChains(),
    ),
    related_chain_names: warpCore
      .getTokenChains()
      .filter((chainName) => chainName !== token.chainName)
      .sort()
      .join(','),
  };

  warpRouteTokenBalance.labels(metrics).set(balanceInfo.balance);
  logger.info(
    {
      labels: metrics,
      balance: balanceInfo.balance,
    },
    'Wallet balance updated for token',
  );

  if (balanceInfo.valueUSD) {
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.info(
      {
        labels: metrics,
        valueUSD: balanceInfo.valueUSD,
      },
      'Wallet value updated for token',
    );
  }
}
// TODO: This does not need to be a separate function, we can redefine updateTokenBalanceMetrics to be generic
// TODO: Consider adding some identifier for the managedLockbox contract, could be adding collateralName label for lockboxes, this would help different manages lockboxes that has a different collateral token
export function updateManagedLockboxBalanceMetrics(
  warpCore: WarpCore,
  chainName: ChainName,
  tokenName: string,
  tokenAddress: string,
  lockBoxAddress: string,
  balanceInfo: WarpRouteBalance,
  collateralTokenSymbol: string,
) {
  const metrics: WarpRouteMetrics = {
    chain_name: chainName,
    token_address: tokenAddress,
    token_name: tokenName,
    wallet_address: lockBoxAddress,
    token_standard: 'EvmManagedLockbox', // TODO: we should eventually a new TokenStandard for this
    warp_route_id: createWarpRouteConfigId(
      collateralTokenSymbol,
      warpCore.getTokenChains(),
    ),
    related_chain_names: warpCore
      .getTokenChains()
      .filter((_chainName) => _chainName !== chainName)
      .sort()
      .join(','),
  };

  warpRouteTokenBalance.labels(metrics).set(balanceInfo.balance);
  logger.info(
    {
      labels: metrics,
      balance: balanceInfo.balance,
    },
    'ManagedLockbox collateral balance updated',
  );

  if (balanceInfo.valueUSD) {
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.info(
      {
        labels: metrics,
        valueUSD: balanceInfo.valueUSD,
      },
      'ManagedLockbox value updated for token',
    );
  }
}

export function updateNativeWalletBalanceMetrics(balance: NativeWalletBalance) {
  walletBalanceGauge
    .labels({
      chain: balance.chain,
      wallet_address: balance.walletAddress,
      wallet_name: balance.walletName,
      token_symbol: 'Native',
      token_name: 'Native',
    })
    .set(balance.balance);
  logger.info('Native wallet balance updated', {
    balanceInfo: balance,
  });
}

export function updateXERC20LimitsMetrics(
  token: Token,
  limits: XERC20Limit,
  bridgeAddress: Address,
  bridgeLabel: string,
  xERC20Address: Address,
) {
  const labels = {
    chain_name: token.chainName,
    token_name: token.name,
    bridge_address: bridgeAddress,
    token_address: xERC20Address,
    bridge_label: bridgeLabel,
  };

  for (const [limitType, limit] of Object.entries(limits)) {
    xERC20LimitsGauge
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
