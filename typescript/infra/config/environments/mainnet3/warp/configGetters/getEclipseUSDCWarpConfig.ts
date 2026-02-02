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
import { getChainAddresses, getChainMetadata } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import {
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
const awProxyAdminAddresses: ChainMap<string> = {
  arbitrum: '0x80Cebd56A65e46c474a1A101e89E76C4c51D179c',
  base: '0x4Ed7d626f1E96cD1C0401607Bf70D95243E3dEd1',
  ethereum: '0x75EE15Ee1B4A75Fa3e2fDF5DF3253c25599cc659',
  optimism: '0xE047cb95FB3b7117989e911c6afb34771183fC35',
  polygon: '0xC4F7590C5d30BE959225dC75640657954A86b980',
  unichain: '0x2f2aFaE1139Ce54feFC03593FeE8AB2aDF4a85A7',
} as const;

const awProxyAdminOwners: ChainMap<string | undefined> = {
  arbitrum: chainOwners.arbitrum.ownerOverrides?.proxyAdmin,
  base: chainOwners.base.ownerOverrides?.proxyAdmin,
  ethereum: chainOwners.ethereum.ownerOverrides?.proxyAdmin,
  optimism: chainOwners.optimism.ownerOverrides?.proxyAdmin,
  polygon: chainOwners.polygon.ownerOverrides?.proxyAdmin,
  unichain: chainOwners.unichain.ownerOverrides?.proxyAdmin,
} as const;

const evmDeploymentChains = [
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
const nonEvmDeploymentChains = ['eclipsemainnet', 'solanamainnet'];

const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

// EVM chains with CCTP rebalancing support
const rebalanceableCollateralChains = [
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

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: awSafes.arbitrum,
  base: awSafes.base,
  optimism: awSafes.optimism,
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
const PROGRAM_IDS = {
  eclipsemainnet: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
  solanamainnet: '3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm',
};

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure EVM collateral chains with rebalancing and linear fees
  for (const currentChain of rebalanceableCollateralChains) {
    const baseConfig = getRebalancingUSDCConfigForChain(
      currentChain,
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    );

    configs.push([
      currentChain,
      {
        ...baseConfig,
        proxyAdmin: {
          owner:
            awProxyAdminOwners[currentChain] ?? chainOwners[currentChain].owner,
          address: awProxyAdminAddresses[currentChain],
        },
        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(currentChain),
          rebalanceableCollateralChains.filter((c) => c !== currentChain),
          5n,
        ),
      },
    ]);
  }

  // Configure Evm collateral for non-rebalancing chains
  const nonRebalanceableCollateralChains = difference(
    new Set<DeploymentChain>(evmDeploymentChains),
    new Set<DeploymentChain>(rebalanceableCollateralChains),
  );

  nonRebalanceableCollateralChains.forEach((chain) => {
    const usdcToken =
      usdcTokenAddresses[chain as keyof typeof usdcTokenAddresses];
    assert(
      usdcToken,
      `USDC address not defined in usdcTokenAddresses for ${chain}`,
    );

    configs.push([
      chain,
      {
        type: TokenType.collateral,
        token: usdcToken,
        owner: ownersByChain[chain],
        mailbox: routerConfig[chain].mailbox,
      },
    ]);
  });

  // Configure non-evm chains
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: PROGRAM_IDS.eclipsemainnet,
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
      foreignDeployment: PROGRAM_IDS.solanamainnet,
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};

export function getUSDCEclipseFileSubmitterStrategyConfig(): ChainSubmissionStrategy {
  // 'file' submitter type is CLI-specific (not in SDK types), so we use type assertion
  return Object.fromEntries(
    Object.entries(ownersByChain)
      .filter(([chain, _]) => evmDeploymentChains.includes(chain))
      .map(([chain, _]) => [
        chain,
        {
          submitter: {
            type: 'file',
            filepath: '/tmp/eclipse-usdc-combined.json',
            chain,
          },
        },
      ]),
  ) as unknown as ChainSubmissionStrategy;
}

export const getEclipseUSDCStrategyConfig = (): ChainSubmissionStrategy => {
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
