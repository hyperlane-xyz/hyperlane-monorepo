import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcasLegacy } from '../../governance/ica/_awLegacy.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getUSDCRebalancingBridgesConfigFor,
  mergeAllowedBridges,
} from './utils.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'polygon',
  'unichain',
  'solanamainnet',
  'subtensor',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const syntheticChain: DeploymentChain = 'subtensor';

// getUSDCRebalancingBridgesConfigFor intersects with the CCTP V1 route chains,
// which excludes subtensor (domain 964) and solanamainnet (domain 1399811149).
// On-chain, each collateral leg also allows rebalancing to those two domains via
// its own bridge, so hardcode them to accept the deployed state.
const SUBTENSOR_DOMAIN = '964';
const SOLANA_DOMAIN = '1399811149';
const onchainRebalancingBridgeByChain: Record<string, string> = {
  arbitrum: '0x8a82186ea618b91d13a2041fb7ac31bf01c02ad2',
  base: '0x5c4afb7e23b1dc1b409dc1702f89c64527b25975',
  ethereum: '0xedcbaa585fd0f80f20073f9958246476466205b8',
  polygon: '0xa62f45662809f5f6535b58bae9a572a2ec4a1f84',
  unichain: '0x296af86bff91b23cf980f6a443bc15a3a5d30682',
};

export const getSubtensorUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    deploymentChains,
    [WarpRouteIds.MainnetCCTPV1],
  );

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner =
          awIcasLegacy[currentChain] ??
          awSafes[currentChain] ??
          chainOwners[currentChain].owner;

        if (currentChain === syntheticChain) {
          return [
            currentChain,
            {
              type: TokenType.synthetic,
              mailbox: routerConfig[currentChain].mailbox,
              owner,
            },
          ];
        }

        const usdcTokenAddress = usdcTokenAddresses[currentChain];
        assert(
          usdcTokenAddress,
          `USDC token address not found for chain ${currentChain}`,
        );

        if (currentChain === 'solanamainnet') {
          return [
            currentChain,
            {
              type: TokenType.collateral,
              token: usdcTokenAddress,
              mailbox: routerConfig[currentChain].mailbox,
              foreignDeployment: 'GPCsiXvm9NaFjrxB6sThscap6akyvRgD5V6decCk25c',
              owner,
              gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
            },
          ];
        }

        const currentRebalancingConfig = rebalancingConfigByChain[currentChain];
        assert(
          currentRebalancingConfig,
          `Rebalancing config not found for chain ${currentChain}`,
        );

        const { allowedRebalancers, allowedRebalancingBridges } =
          currentRebalancingConfig;

        const onchainBridge = onchainRebalancingBridgeByChain[currentChain];
        const mergedBridges = onchainBridge
          ? mergeAllowedBridges(allowedRebalancingBridges, {
              [SUBTENSOR_DOMAIN]: [{ bridge: onchainBridge }],
              [SOLANA_DOMAIN]: [{ bridge: onchainBridge }],
            })
          : allowedRebalancingBridges;

        return [
          currentChain,
          {
            type: TokenType.collateral,
            token: usdcTokenAddress,
            mailbox: routerConfig[currentChain].mailbox,
            owner,
            allowedRebalancers,
            allowedRebalancingBridges: mergedBridges,
            contractVersion: '8.1.1',
          },
        ];
      },
    ),
  );
};
