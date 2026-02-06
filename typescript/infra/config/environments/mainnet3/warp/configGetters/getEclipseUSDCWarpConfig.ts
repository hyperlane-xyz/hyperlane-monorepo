import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert, difference } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getChainAddresses } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getFileSubmitterStrategyConfig,
  getFixedRoutingFeeConfig,
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

/**
 * Eclipse USDC Warp Route
 *
 * A multi-chain USDC warp route connecting Eclipse with major EVM chains and Solana.
 *
 * Chains:
 * - EVM (collateral): Ethereum, Arbitrum, Base, Optimism, Polygon, Unichain, ink, worldchain, avalanche, hyperevm, linea, monad
 * - SVM (synthetic): Eclipse
 * - SVM (collateral): Solana
 *
 * Features:
 * - CCTP V2 rebalancing bridges (Standard + Fast) on all EVM chains
 * - Routing fee: 5 bps for EVM-to-EVM transfers, 0 bps for EVM-to-SVM transfers
 * - Contract version 10.1.3
 */

export const evmDeploymentChains = [
  'ethereum',
  'arbitrum',
  'base',
  'optimism',
  'polygon',
  'unichain',
  'ink',
  'worldchain',
  'avalanche',
  'hyperevm',
  'linea',
  'monad',
];
export const nonEvmDeploymentChains = ['eclipsemainnet', 'solanamainnet'];

const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

// EVM chains with CCTP rebalancing support
export const rebalanceableCollateralChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
  'polygon',
  'unichain',
  'ink',
  'worldchain',
  'avalanche',
  'hyperevm',
  'linea',
  // No monad yet
] as const satisfies DeploymentChain[];

// On-chain LinearFee parameters for already-deployed chains.
// These were deployed with the original bps logic of using the totalSupply()
// Without these, warp apply will redeploy the fees
const deployedChainFeeParams: Record<
  string,
  { maxFee: string; halfAmount: string }
> = {
  arbitrum: {
    maxFee: '18459382986016399860015592127403368310046070992504417749897631',
    halfAmount:
      '18459382986016399860015592127403368310046070992504417749897630000',
  },
  base: {
    maxFee: '27099327091626495140416592859206796555048937074435830815167597',
    halfAmount:
      '27099327091626495140416592859206796555048937074435830815167596000',
  },
  ethereum: {
    maxFee: '2207817649756434359838725503051961931875524909323049373661705',
    halfAmount:
      '2207817649756434359838725503051961931875524909323049373661704000',
  },
  optimism: {
    maxFee: '557857035769277571442107158893568717753786146662512570068048277',
    halfAmount:
      '557857035769277571442107158893568717753786146662512570068048276000',
  },
  polygon: {
    maxFee: '189444232384281426231109839818586514265950429404753541975752862',
    halfAmount:
      '189444232384281426231109839818586514265950429404753541975752862000',
  },
  unichain: {
    maxFee: '2675917496765118465156267568419760491445101099689821059982086779',
    halfAmount:
      '2675917496765118465156267568419760491445101099689821059982086778000',
  },
};

const productionOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  optimism: awIcas.optimism,
  polygon: awIcas.polygon,
  unichain: awIcas.unichain,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
  ink: awIcas.ink,
  worldchain: awIcas.worldchain,
  avalanche: awIcas.avalanche,
  hyperevm: awIcas.hyperevm,
  linea: awIcas.linea,
  monad: awIcas.monad,
};

// TODO: can we read this from a config file?
const PRODUCTION_PROGRAM_IDS = {
  eclipsemainnet: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
  solanamainnet: '3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm',
};

export interface EclipseUSDCWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  programIds: { eclipsemainnet: string; solanamainnet: string };
  tokenMetadata?: { symbol: string; name: string };
  proxyAdminOverride?: Partial<Record<DeploymentChain, string>>;
}

export const buildEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: EclipseUSDCWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ownersByChain, programIds, tokenMetadata, proxyAdminOverride } =
    options;

  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure EVM collateral chains
  const rebalanceableSet = new Set<string>(rebalanceableCollateralChains);

  for (const chain of evmDeploymentChains) {
    let chainConfig: HypTokenRouterConfig;

    if (rebalanceableSet.has(chain)) {
      const baseConfig = getRebalancingUSDCConfigForChain(
        chain as (typeof rebalanceableCollateralChains)[number],
        routerConfig,
        ownersByChain,
        rebalancingConfigByChain,
      );
      const destinations = rebalanceableCollateralChains.filter(
        (c) => c !== chain,
      );
      const originFeeParams = deployedChainFeeParams[chain];
      const feeParams = originFeeParams
        ? Object.fromEntries(destinations.map((d) => [d, originFeeParams]))
        : undefined;
      chainConfig = {
        ...baseConfig,
        ...tokenMetadata,
        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(chain),
          destinations,
          5n,
          feeParams,
        ),
      };
    } else {
      const usdcToken =
        usdcTokenAddresses[chain as keyof typeof usdcTokenAddresses];
      assert(usdcToken, `USDC address not defined for ${chain}`);
      chainConfig = {
        ...tokenMetadata,
        type: TokenType.collateral,
        token: usdcToken,
        owner: ownersByChain[chain],
        mailbox: routerConfig[chain].mailbox,
      };
    }

    const proxyAdmin = proxyAdminOverride?.[chain];
    if (proxyAdmin) {
      chainConfig.ownerOverrides = { proxyAdmin };
    }

    configs.push([chain, chainConfig]);
  }

  // Configure non-evm chains
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: programIds.eclipsemainnet,
      owner: ownersByChain.eclipsemainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: usdcTokenAddresses.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: programIds.solanamainnet,
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const proxyAdminOverride = Object.fromEntries(
    evmDeploymentChains.map((chain) => {
      const safe = awSafes[chain];
      assert(safe, `AW safe not defined for ${chain}`);

      return [chain, safe];
    }),
  );

  return buildEclipseUSDCWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    programIds: PRODUCTION_PROGRAM_IDS,
    proxyAdminOverride,
  });
};

// Strategies
export const getUSDCEclipseFileSubmitterStrategyConfig = () =>
  getFileSubmitterStrategyConfig(
    evmDeploymentChains,
    '/tmp/eclipse-usdc-combined.json',
  );

export const getEclipseUSDCStrategyConfig = (): ChainSubmissionStrategy => {
  // TODO: Remove this after transferring ownership
  const safeChains = ['ethereum', 'arbitrum', 'base', 'optimism'] as const;
  const originSafeChain = 'ethereum';
  const originSafeAddress = awSafes[originSafeChain];

  const originSafeSubmitter = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER as const,
    chain: originSafeChain,
    safeAddress: originSafeAddress,
    version: '1.0',
  };

  // Safe-owned chains get direct safe submitters
  const safeStrategies: [string, SubmissionStrategy][] = safeChains.map(
    (chain) => [
      chain,
      {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER as const,
          chain,
          safeAddress: awSafes[chain],
          version: '1.0',
        },
      },
    ],
  );

  // ICA-owned chains use ICA submitter with ethereum safe as origin
  const icaChains = difference(
    new Set<(typeof evmDeploymentChains)[number]>(evmDeploymentChains),
    new Set<(typeof evmDeploymentChains)[number]>(safeChains),
  );

  const icaStrategies: [string, SubmissionStrategy][] = [...icaChains].map(
    (chain) => {
      const chainAddress = getChainAddresses()[chain];
      assert(chainAddress, `Could not fetch addresses for chain ${chain}`);
      const originInterchainAccountRouter =
        chainAddress.interchainAccountRouter;
      assert(
        originInterchainAccountRouter,
        `Could not fetch originInterchainAccountRouter for chain ${chain}`,
      );

      return [
        chain,
        {
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
            chain: originSafeChain,
            destinationChain: chain,
            owner: originSafeAddress,
            originInterchainAccountRouter,
            internalSubmitter: originSafeSubmitter,
          },
        },
      ];
    },
  );

  return Object.fromEntries([...safeStrategies, ...icaStrategies]);
};
