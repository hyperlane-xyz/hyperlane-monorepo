import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { regularSafes } from '../../governance/safe/regular.js';
import { chainOwners, upgradeTimelocks } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import {
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

/**
 * Stage 2: Add rebalancing config to all EVM chains
 *
 * This config produces:
 * - Ethereum: Add rebalancing configuration (enroll arbitrum/base, set destination gas, add rebalancer role, add CCTP bridges)
 * - Arbitrum: add CCTP bridges
 * - Base: add CCTP bridges
 * - Eclipse/Solana: Unchanged
 *
 * Transactions generated:
 * - AW Safe (ethereum): Configuration transactions only
 * - Deployer key (arbitrum/base): Configuration transactions only
 */
const awProxyAdminAddresses: ChainMap<string> = {
  arbitrum: '0x80Cebd56A65e46c474a1A101e89E76C4c51D179c',
  base: '0x4Ed7d626f1E96cD1C0401607Bf70D95243E3dEd1',
  ethereum: '0x75EE15Ee1B4A75Fa3e2fDF5DF3253c25599cc659',
};

const awProxyAdminOwners: ChainMap<string> = {
  arbitrum: upgradeTimelocks.arbitrum ?? regularSafes.arbitrum,
  base: regularSafes.base,
  ethereum: regularSafes.ethereum,
};

const DEPLOYER = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

const deploymentChains = [
  'ethereum',
  'arbitrum',
  'base',
  'eclipsemainnet',
  'solanamainnet',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

// All EVM chains get rebalancing in Stage 2
const rebalanceableCollateralChains = [
  'arbitrum',
  'base',
  'ethereum',
] as const satisfies DeploymentChain[];

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: DEPLOYER,
  base: DEPLOYER,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
};

const CONTRACT_VERSION = '9.0.16';

const PROGRAM_IDS = {
  eclipsemainnet: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
  solanamainnet: '3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm',
};

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableCollateralChains,
  );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // All EVM chains get rebalancing in Stage 2
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
        proxyAdmin: {
          owner: awProxyAdminOwners[currentChain],
          address: awProxyAdminAddresses[currentChain],
        },
      },
    ]);
  }

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
