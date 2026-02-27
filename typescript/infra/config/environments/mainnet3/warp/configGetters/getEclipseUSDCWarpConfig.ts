import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

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
export const awProxyAdminAddresses: ChainMap<string> = {
  arbitrum: '0x33465314CbD880976B7A9f86062d615DE5E4Fa8A',
  base: '0x4e60dB3117AB7322949dC0A8E952D0cD413B1132',
  ethereum: '0x692e50577fAaBF10F824Dc8Ce581e3Af93785175',
  optimism: '0x51ec280B550be2999995f0d931Ac2974B9D9304E',
  polygon: '0xD65217cA148C1074DdF59Bd95079Da76c65e130E',
  unichain: '0xe175575c38726fd2B62b12e01D92e3F170a90059',
  avalanche: '0x75a06e84226311B71749EF4F33B1e628D7999b83',
  linea: '0x71644C723D205E9Bc9C1939ee7bffECf7b5C9687',
  monad: '0x8F8FEf4Af7575c0A0f9455565ab807484Bb55987',
  ink: '0x3Ee33a0F98c06eE3d3E5c1717bD3AfbB0f749879',
  worldchain: '0xbcA7cc1c87E67341463f62F00Ea096564cAD13C1',
  hyperevm: '0xa5ff938C9DdC524d98ebf0297e39A6F5918Db2CD',
} as const;

const awProxyAdminOwners: ChainMap<string | undefined> = {
  arbitrum: awSafes.arbitrum,
  base: awSafes.base,
  ethereum: awSafes.ethereum,
  optimism: awSafes.optimism,
  polygon: awSafes.polygon,
  unichain: awSafes.unichain,
  avalanche: awSafes.avalanche,
  linea: awSafes.linea,
  monad: awSafes.monad,
  ink: awSafes.ink,
  worldchain: awSafes.worldchain,
  hyperevm: awSafes.hyperevm,
} as const;

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
// Without these, warp apply will 1) redeploy the fees and 2) warp check will show diffs
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
  avalanche: {
    maxFee: '115792089237316195423570985008687907853269',
    halfAmount: '115792089237316195423570985008687907853268000',
  },
  hyperevm: {
    maxFee: '115792089237316195423570985008687907853269',
    halfAmount: '115792089237316195423570985008687907853268000',
  },
  ink: {
    maxFee: '115792089237316195423570985008687907853269',
    halfAmount: '115792089237316195423570985008687907853268000',
  },
  linea: {
    maxFee: '115792089237316195423570985008687907853269',
    halfAmount: '115792089237316195423570985008687907853268000',
  },
  worldchain: {
    maxFee: '115792089237316195423570985008687907853269',
    halfAmount: '115792089237316195423570985008687907853268000',
  },
};

export const productionOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  base: '0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7',
  optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC',
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
  proxyAdmins: ChainMap<{ address: string; owner: string }>;
}

export const buildEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: EclipseUSDCWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ownersByChain, programIds, tokenMetadata, proxyAdmins } = options;

  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure EVM collateral chains
  const rebalanceableSet = new Set<string>(rebalanceableCollateralChains);

  for (const chain of evmDeploymentChains) {
    let chainConfig: HypTokenRouterConfig;
    const proxyAdmin = proxyAdmins[chain];
    assert(proxyAdmin, `Missing proxyAdmin for chain ${chain}`);

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
        proxyAdmin,
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
        proxyAdmin,
        mailbox: routerConfig[chain].mailbox,
      };
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

const awProxyAdmins: ChainMap<{ address: string; owner: string }> =
  Object.fromEntries(
    Object.entries(awProxyAdminAddresses).map(([chain, address]) => [
      chain,
      {
        address,
        owner: awProxyAdminOwners[chain] ?? chainOwners[chain].owner,
      },
    ]),
  );

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildEclipseUSDCWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    programIds: PRODUCTION_PROGRAM_IDS,
    proxyAdmins: awProxyAdmins,
  });

// Strategies
export const getUSDCEclipseFileSubmitterStrategyConfig = () =>
  getFileSubmitterStrategyConfig(
    evmDeploymentChains,
    '/tmp/eclipse-usdc-combined.json',
  );

const ORIGIN_CHAIN = 'ethereum';

export const getEclipseUSDCStrategyConfig = (): ChainSubmissionStrategy => {
  const safeAddress = awSafes[ORIGIN_CHAIN];
  const originSafeSubmitter = {
    type: TxSubmitterType.GNOSIS_SAFE as const,
    chain: ORIGIN_CHAIN,
    safeAddress,
  };

  const chainAddress = getChainAddresses();
  const originInterchainAccountRouter =
    chainAddress[ORIGIN_CHAIN].interchainAccountRouter;
  assert(
    originInterchainAccountRouter,
    `Could not fetch originInterchainAccountRouter for ${ORIGIN_CHAIN}`,
  );

  const icaChains = evmDeploymentChains.filter((c) => c !== ORIGIN_CHAIN);
  const icaStrategies: [string, SubmissionStrategy][] = icaChains.map(
    (chain) => [
      chain,
      {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
          chain: ORIGIN_CHAIN,
          destinationChain: chain,
          owner: safeAddress,
          originInterchainAccountRouter,
          internalSubmitter: originSafeSubmitter,
        },
      },
    ],
  );

  return Object.fromEntries([
    [ORIGIN_CHAIN, { submitter: originSafeSubmitter }],
    ...icaStrategies,
  ]);
};
