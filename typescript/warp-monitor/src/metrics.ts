import http from 'http';
import { Gauge, Registry } from 'prom-client';

import {
  type ChainName,
  type Token,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type {
  NativeWalletBalance,
  WarpRouteBalance,
  XERC20Limit,
} from './types.js';
import { getLogger } from './utils.js';

export const metricsRegister = new Registry();

type SupportedTokenStandards = TokenStandard | 'EvmManagedLockbox' | 'xERC20';

interface BaseWarpRouteMetrics {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  warp_route_id: string;
}

interface WarpRouteMetrics extends BaseWarpRouteMetrics {
  wallet_address: string;
  token_standard: SupportedTokenStandards;
  related_chain_names: string;
}

type WarpRouteMetricLabels = keyof WarpRouteMetrics;

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

interface WarpRouteValueAtRiskMetrics extends BaseWarpRouteMetrics {
  collateral_chain_name: ChainName;
  collateral_token_standard: SupportedTokenStandards;
}

type WarpRouteValueAtRiskMetricLabels = keyof WarpRouteValueAtRiskMetrics;

const warpRouteValueAtRiskLabels: WarpRouteValueAtRiskMetricLabels[] = [
  'chain_name',
  'collateral_chain_name',
  'token_address',
  'token_name',
  'collateral_token_standard',
  'warp_route_id',
];

const warpRouteValueAtRisk = new Gauge({
  name: 'hyperlane_warp_route_value_at_risk',
  help: 'Value at risk on chain for a given Warp Route',
  registers: [metricsRegister],
  labelNames: warpRouteValueAtRiskLabels,
});

function createWalletBalanceGauge(
  register: Registry,
  additionalLabels: string[] = [],
): Gauge {
  return new Gauge({
    // Mirror the rust/main/ethers-prometheus `wallet_balance` gauge metric.
    name: 'hyperlane_wallet_balance',
    help: 'Current balance of a wallet for a token',
    registers: [register],
    labelNames: [
      'chain',
      'wallet_address',
      'wallet_name',
      'token_address',
      'token_symbol',
      'token_name',
      ...additionalLabels,
    ],
  });
}

const walletBalanceGauge = createWalletBalanceGauge(metricsRegister);

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
  warpRouteId: string,
): void {
  const logger = getLogger();
  const allChains = warpCore.getTokenChains().sort();
  const relatedChains = allChains.filter(
    (chainName) => chainName !== token.chainName,
  );

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
    warp_route_id: warpRouteId,
    // TODO: consider deprecating this label given that we have the value at risk metric
    related_chain_names: relatedChains.join(','),
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
    // TODO: consider deprecating this metric in favor of the value at risk metric
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.info(
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

export function updateManagedLockboxBalanceMetrics(
  warpCore: WarpCore,
  chainName: ChainName,
  tokenName: string,
  tokenAddress: string,
  lockBoxAddress: string,
  balanceInfo: WarpRouteBalance,
  warpRouteId: string,
): void {
  const logger = getLogger();
  const metrics: WarpRouteMetrics = {
    chain_name: chainName,
    token_address: tokenAddress,
    token_name: tokenName,
    wallet_address: lockBoxAddress,
    token_standard: 'EvmManagedLockbox', // TODO: we should eventually a new TokenStandard for this
    warp_route_id: warpRouteId,
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

export function updateNativeWalletBalanceMetrics(
  balance: NativeWalletBalance,
): void {
  const logger = getLogger();
  walletBalanceGauge
    .labels({
      chain: balance.chain,
      wallet_address: balance.walletAddress,
      wallet_name: balance.walletName,
      token_address: 'native',
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
): void {
  const logger = getLogger();
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

/**
 * Start a simple HTTP server to host metrics. This just takes the registry and dumps the text
 * string to people who request `GET /metrics`.
 *
 * PROMETHEUS_PORT env var is used to determine what port to host on, defaults to 9090.
 */
export function startMetricsServer(register: Registry): http.Server {
  const logger = getLogger();
  return http
    .createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404, 'Invalid url').end();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, 'Invalid method').end();
        return;
      }

      register
        .metrics()
        .then((metricsStr) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end(metricsStr);
        })
        .catch((err) => {
          logger.error(err, 'Failed to collect metrics');
          res
            .writeHead(500, { 'Content-Type': 'text/plain' })
            .end('Internal Server Error');
        });
    })
    .listen(parseInt(process.env['PROMETHEUS_PORT'] || '9090'));
}
