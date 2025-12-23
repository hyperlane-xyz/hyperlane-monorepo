import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import {
  getCCTPV2RebalancingBridgesConfigFor,
  getRebalancingUSDCConfigForChain,
} from './utils.js';

/**
 * Stage 3: Extend to Optimism, Polygon, Unichain, use MainnetCCTPV2Standard and MainnetCCTPV2Fast bridges
 *
 * This config produces:
 * - Ethereum: Add rebalancing configuration (enroll arbitrum/base, set destination gas, add rebalancer role, add CCTP bridges)
 * - Arbitrum: add CCTP bridges
 * - Base: add CCTP bridges
 * - Optimism, Polygon, Unichain: Deploy routers with rebalancing
 * - Eclipse/Solana: Unchanged
 *
 * Transactions generated:
 * - AW Safe (ethereum): Configuration transactions only
 * - Deployer key (arbitrum/base/optimism/polygon/unichain): Configuration transactions only
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

const DEPLOYER = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

const deploymentChains = [
  'ethereum',
  'arbitrum',
  'base',
  'optimism',
  'polygon',
  'unichain',
  'eclipsemainnet',
  'solanamainnet',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

// All EVM chains get rebalancing in Stage 2
const rebalanceableCollateralChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
  'polygon',
  'unichain',
] as const satisfies DeploymentChain[];

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: DEPLOYER,
  base: DEPLOYER,
  optimism: DEPLOYER,
  polygon: DEPLOYER,
  unichain: DEPLOYER,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
};

const PROGRAM_IDS = {
  eclipsemainnet: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
  solanamainnet: '3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm',
};

export const getEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getCCTPV2RebalancingBridgesConfigFor(
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
        proxyAdmin: {
          owner:
            awProxyAdminOwners[currentChain] ?? chainOwners[currentChain].owner,
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
