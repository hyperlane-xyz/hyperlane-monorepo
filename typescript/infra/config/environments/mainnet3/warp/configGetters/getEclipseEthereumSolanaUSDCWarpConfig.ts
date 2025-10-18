import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const deploymentChains = [
  'ethereum',
  'arbitrum',
  'base',
  'eclipsemainnet',
  'solanamainnet',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const rebalanceableCollateralChains = [
  'ethereum',
  'arbitrum',
  'base',
] as const satisfies DeploymentChain[];

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: awSafes.arbitrum,
  base: awSafes.base,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
};

const CONTRACT_VERSION = '8.1.1';

export const getEclipseEthereumSolanaUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Handle rebalanceable collateral chains (EVM chains with rebalancing)
  for (const currentChain of rebalanceableCollateralChains) {
    const owner = ownersByChain[currentChain];
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
        owner,
        allowedRebalancers,
        allowedRebalancingBridges,
        contractVersion: CONTRACT_VERSION,
      },
    ]);
  }

  // Handle synthetic chain (Eclipse)
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
      owner: ownersByChain.eclipsemainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  // Handle non-rebalanceable collateral chain (Solana)
  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: usdcTokenAddresses.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: '3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm',
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};
