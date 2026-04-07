import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

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
  getCollateralTokenConfigForChain,
  getFileSubmitterStrategyConfig,
  getFixedRoutingFeeConfig,
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

type DeploymentChains<T> = {
  ethereum: T;
  arbitrum: T;
  base: T;
  bsc: T;
  optimism: T;
  polygon: T;
  katana: T;
  unichain: T;
  eclipsemainnet: T;
  solanamainnet: T;
  ink: T;
  worldchain: T;
  avalanche: T;
  hyperevm: T;
  linea: T;
  monad: T;
};

export type DeploymentChain = keyof DeploymentChains<unknown>;

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
  'arbitrum',
  'avalanche',
  'base',
  'bsc',
  'ethereum',
  'hyperevm',
  'ink',
  'katana',
  'linea',
  'monad',
  'optimism',
  'polygon',
  'unichain',
  'worldchain',
] as const satisfies DeploymentChain[];

type EvmChain = (typeof evmDeploymentChains)[number];

export const nonEvmDeploymentChains = [
  'eclipsemainnet',
  'solanamainnet',
] as const satisfies DeploymentChain[];

export const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const satisfies DeploymentChain[];

// EVM chains with CCTP rebalancing support
export const cctpRebalanceableChains = [
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
const cctpRebalanceableSet = new Set<EvmChain>(cctpRebalanceableChains);

export const rebalancingChains = [
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
  'bsc',
  'katana',
] as const satisfies DeploymentChain[];

const awProxyAdminAddresses: Record<EvmChain, string | undefined> = {
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

  bsc: undefined,
  katana: undefined,
} as const;

const awProxyAdminOwners: Record<EvmChain, string> = {
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

  bsc: awSafes.bsc,
  katana: awSafes.katana,
} as const;

const productionOwnersByChain: DeploymentChains<string> = {
  ethereum: awSafes.ethereum,
  // Explicitly set from typescript/infra/config/environments/mainnet3/governance/ica/aw.ts
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  base: '0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7',
  bsc: '0x269Af9E53192AF49a22ff47e30b89dE1375AE1fd',
  optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC',
  //
  polygon: awIcas.polygon,
  katana: awIcas.katana,
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

const SVM_IGP_ADDRESSES = {
  eclipsemainnet: 'Hs7KVBU67nBnWhDPZkEFwWqrFMUfJbmY2DQ4gmCZfaZp',
  solanamainnet: 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv',
} as const;

export interface EclipseUSDCWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  programIds: { eclipsemainnet: string; solanamainnet: string };
  tokenMetadata?: { symbol: string; name: string };
  proxyAdmins: ChainMap<{ address: string | undefined; owner: string }>;
}

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  cctpRebalanceableChains,
  [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
);

export const buildEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: EclipseUSDCWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ownersByChain, programIds, tokenMetadata, proxyAdmins } = options;

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];
  for (const currentChain of deploymentChains) {
    // Scaling
    const scaleConfig =
      currentChain === 'bsc'
        ? {
            numerator: 1,
            denominator: 10 ** 12,
          }
        : {
            numerator: 1,
            denominator: 1,
          };

    let chainConfig: HypTokenRouterConfig;
    if (currentChain === 'eclipsemainnet') {
      chainConfig = {
        type: TokenType.synthetic,
        mailbox: routerConfig.eclipsemainnet.mailbox,
        hook: SVM_IGP_ADDRESSES.eclipsemainnet,
        foreignDeployment: programIds.eclipsemainnet,
        owner: ownersByChain.eclipsemainnet,
        gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      };
    } else if (currentChain === 'solanamainnet') {
      chainConfig = {
        type: TokenType.collateral,
        token: usdcTokenAddresses.solanamainnet,
        mailbox: routerConfig.solanamainnet.mailbox,
        hook: SVM_IGP_ADDRESSES.solanamainnet,
        foreignDeployment: programIds.solanamainnet,
        owner: ownersByChain.solanamainnet,
        gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      };
    } else {
      // Proxy admin config
      const proxyAdmin = proxyAdmins[currentChain];
      assert(proxyAdmin, `Missing proxyAdmin for chain ${currentChain}`);

      // Fees
      const feeDestinations = evmDeploymentChains.filter(
        (otherChain) => otherChain !== currentChain,
      );
      const feeConfig = getFixedRoutingFeeConfig(
        getWarpFeeOwner(currentChain),
        feeDestinations,
        1.5,
      );

      const baseConfig = cctpRebalanceableSet.has(currentChain)
        ? getRebalancingUSDCConfigForChain(
            currentChain,
            routerConfig,
            ownersByChain,
            rebalancingConfigByChain,
            feeConfig,
          )
        : getCollateralTokenConfigForChain(
            currentChain,
            routerConfig,
            ownersByChain,
            usdcTokenAddresses,
            feeConfig,
          );

      chainConfig = {
        ...baseConfig,
        ...tokenMetadata,
        proxyAdmin,
        tokenFee: feeConfig,
        scale: scaleConfig,
      };
    }

    configs.push([currentChain, chainConfig]);
  }

  return Object.fromEntries(configs);
};

const awProxyAdmins: ChainMap<{ address: string | undefined; owner: string }> =
  objMap(awProxyAdminAddresses, (chain, address) => {
    const proxyAdminOwner =
      awProxyAdminOwners[chain] ?? chainOwners[chain].owner;

    assert(
      proxyAdminOwner,
      `Expected proxy admin owner to be defined for chain ${proxyAdminOwner}`,
    );

    return {
      address: address,
      owner: proxyAdminOwner,
    };
  });

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildEclipseUSDCWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    programIds: PRODUCTION_PROGRAM_IDS,
    proxyAdmins: awProxyAdmins,
    tokenMetadata: {
      name: 'USDC Coin',
      symbol: 'USDC',
    },
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
    type: TxSubmitterType.GNOSIS_TX_BUILDER as const,
    chain: ORIGIN_CHAIN,
    safeAddress,
    version: '1',
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

  const svmFileStrategies: [
    string,
    { submitter: { type: 'file'; filepath: string } },
  ][] = nonEvmDeploymentChains.map((chain) => [
    chain,
    {
      submitter: {
        type: 'file' as const,
        filepath: `/tmp/eclipse-usdc-${chain}.json`,
      },
    },
  ]);

  return Object.fromEntries([
    [ORIGIN_CHAIN, { submitter: originSafeSubmitter }],
    ...icaStrategies,
    ...svmFileStrategies,
  ]);
};
