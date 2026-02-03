import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { difference } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { DEPLOYER } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getFileSubmitterStrategyConfig,
  getFixedRoutingFeeConfig,
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

const SOLANA_OWNER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

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

const STAGING_PROGRAM_IDS = {
  eclipsemainnet: '6QSWUmEaEcE2KJrU5jq7T11tNRaVsgnG8XULezjg7JjL',
  solanamainnet: 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo',
};

// Staging-specific branding
const STAGING_TOKEN_METADATA = {
  symbol: 'USDCSTAGE',
  name: 'USD Coin STAGE',
};

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: DEPLOYER,
  arbitrum: DEPLOYER,
  base: DEPLOYER,
  optimism: DEPLOYER,
  polygon: DEPLOYER,
  unichain: DEPLOYER,
  eclipsemainnet: SOLANA_OWNER,
  solanamainnet: SOLANA_OWNER,
  ink: DEPLOYER,
  worldchain: DEPLOYER,
  avalanche: DEPLOYER,
  hyperevm: DEPLOYER,
  linea: DEPLOYER,
  monad: DEPLOYER,
};

export const getEclipseUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure EVM collateral chains with rebalancing and routing fees
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
        ...STAGING_TOKEN_METADATA,
        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(currentChain),
          rebalanceableCollateralChains.filter((c) => c !== currentChain),
          5n,
        ),
      },
    ]);
  }

  // Configure EVM collateral for non-rebalancing chains
  const nonRebalanceableCollateralChains = difference(
    new Set<DeploymentChain>(evmDeploymentChains),
    new Set<DeploymentChain>(rebalanceableCollateralChains),
  );

  nonRebalanceableCollateralChains.forEach((chain) => {
    configs.push([
      chain,
      {
        type: TokenType.collateral,
        token: usdcTokenAddresses[chain as keyof typeof usdcTokenAddresses],
        owner: ownersByChain[chain],
        mailbox: routerConfig[chain].mailbox,
        ...STAGING_TOKEN_METADATA,
      },
    ]);
  });

  // Configure non-EVM chains
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: STAGING_PROGRAM_IDS.eclipsemainnet,
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
      foreignDeployment: STAGING_PROGRAM_IDS.solanamainnet,
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};

export const getUSDCSTAGEEclipseFileSubmitterStrategyConfig = () =>
  getFileSubmitterStrategyConfig(
    evmDeploymentChains,
    '/tmp/eclipse-usdcstage-combined.json',
  );
