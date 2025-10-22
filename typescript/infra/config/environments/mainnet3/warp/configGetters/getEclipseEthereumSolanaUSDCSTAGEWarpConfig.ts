import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const EVM_OWNER = '0x7fDFd78B278f88C1A1921B7AeC69aC509862C44f';
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

export const getEclipseEthereumSolanaUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Handle rebalanceable collateral chains (EVM chains with rebalancing)
  for (const currentChain of rebalanceableCollateralChains) {
    const usdcTokenAddress =
      usdcTokenAddresses[currentChain as keyof typeof usdcTokenAddresses];

    assert(
      usdcTokenAddress,
      `USDC token address not found for chain ${currentChain}`,
    );

    const currentRebalancingConfig = rebalancingConfigByChain[currentChain];
    assert(
      currentRebalancingConfig,
      `Rebalancing config not found for chain ${currentChain}`,
    );

    const { allowedRebalancers, allowedRebalancingBridges } =
      currentRebalancingConfig;

    configs.push([
      currentChain,
      {
        type: TokenType.collateral,
        token: usdcTokenAddress,
        mailbox: routerConfig[currentChain].mailbox,
        owner: EVM_OWNER,
        allowedRebalancers,
        allowedRebalancingBridges,
        contractVersion: CONTRACT_VERSION,
        // STAGING: Use test token branding
        symbol: 'USDCSTAGE',
        name: 'USD Coin STAGE',
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
