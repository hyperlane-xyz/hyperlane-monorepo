import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

const SOLANA_OWNER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

const deploymentChains = [
  'ethereum',
  'arbitrum',
  'base',
  'eclipsemainnet',
  'solanamainnet',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

// Chains that support CCTP-based rebalancing
const rebalanceableCollateralChains = [
  'ethereum',
  'arbitrum',
  'base',
] as const satisfies DeploymentChain[];

const CONTRACT_VERSION = '9.0.13';

const STAGING_PROGRAM_IDS = {
  eclipsemainnet: '6QSWUmEaEcE2KJrU5jq7T11tNRaVsgnG8XULezjg7JjL',
  solanamainnet: 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo',
};

// Staging-specific branding
const STAGING_TOKEN_METADATA = {
  symbol: 'USDCSTAGE',
  name: 'USD Coin STAGE',
};

export const getEclipseUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
    WarpRouteIds.MainnetCCTPV1,
  );

  // All EVM chains use the same owner (Safe)
  const evmOwner: Address = '0x7fDFd78B278f88C1A1921B7AeC69aC509862C44f';
  const ownersByChain: ChainMap<Address> = {
    ethereum: evmOwner,
    arbitrum: evmOwner,
    base: evmOwner,
  };

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Handle rebalanceable collateral chains (EVM chains with rebalancing)
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
        contractVersion: CONTRACT_VERSION,
        ...STAGING_TOKEN_METADATA,
      },
    ]);
  }

  // Handle synthetic chain (Eclipse)
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: STAGING_PROGRAM_IDS.eclipsemainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      owner: SOLANA_OWNER,
    },
  ]);

  // Handle non-rebalanceable collateral chain (Solana)
  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: usdcTokenAddresses.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: STAGING_PROGRAM_IDS.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      owner: SOLANA_OWNER,
    },
  ]);

  return Object.fromEntries(configs);
};
