import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { usdcTokenAddresses } from '../cctp.js';
import {
  SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  STARKNET_WARP_ROUTE_HANDLER_GAS_AMOUNT,
} from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'hyperevm',
  'mode',
  'paradex',
  'solanamainnet',
  'starknet',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const nonRebalanceableCollateralChains = [
  'solanamainnet',
  'starknet',
  'paradex',
] as const satisfies DeploymentChain[];

type NonRebalanceableChain = (typeof nonRebalanceableCollateralChains)[number];

const gasByChain: Record<NonRebalanceableChain, number> = {
  solanamainnet: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  starknet: STARKNET_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  paradex: STARKNET_WARP_ROUTE_HANDLER_GAS_AMOUNT,
};

const foreignDeploymentByChain: Record<NonRebalanceableChain, string> = {
  solanamainnet: 'CYiUT9WzmHebQQJ5bBQSsWY7hW2GSwRgQ8gYZLHN7V6D',
  starknet:
    '0x065aa53156379692b54141146c342f90e9c7a1243896a0be0fea6c8960b9261c',
  paradex: '0x0274d8800b7f4f60a13c8cf17fda9e949b099562195ab185ce667f2e483457c5',
};

const syntheticChain: DeploymentChain = 'mode';

// Waiting on the addresses for the final ownership config
const ownersByChain: Record<DeploymentChain, string> = {
  arbitrum: '0xFF57A3bB6465501c993acF8f3b29125a862661C0',
  base: '0xFF57A3bB6465501c993acF8f3b29125a862661C0',
  ethereum: '0xFF57A3bB6465501c993acF8f3b29125a862661C0',
  hyperevm: '0xF74FC89eC0fB0b8f4158353Ef6F0c8D249639EE5',
  mode: '0xFF57A3bB6465501c993acF8f3b29125a862661C0',
  paradex: '0x00395a1eebf43d06be83684da623c4c2ab8e1ea4a89dfa71ee04677b6e19a428',
  solanamainnet: 'HBPwc1dSuaJCEwWkJvfeWUqJguFqPTVaggfDGssc3LVt',
  starknet:
    '0x00af66284c430cc46fd5048312ef134e35141d4499f9450f2e9eff170c7dde08',
};

export const getParadexUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    deploymentChains,
    WarpRouteIds.MainnetCCTPV2Standard,
  );

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner = ownersByChain[currentChain];

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

        const maybeNonRebalanceableChain =
          currentChain as NonRebalanceableChain;
        if (
          !nonRebalanceableCollateralChains.includes(maybeNonRebalanceableChain)
        ) {
          const currentRebalancingConfig =
            rebalancingConfigByChain[currentChain];
          assert(
            currentRebalancingConfig,
            `Rebalancing config not found for chain ${currentChain}`,
          );

          const { allowedRebalancers, allowedRebalancingBridges } =
            currentRebalancingConfig;

          return [
            currentChain,
            {
              type: TokenType.collateral,
              token: usdcTokenAddress,
              mailbox: routerConfig[currentChain].mailbox,
              owner,
              allowedRebalancers,
              allowedRebalancingBridges,
              contractVersion: '8.1.1',
            },
          ];
        }

        return [
          currentChain,
          {
            type: TokenType.collateral,
            token: usdcTokenAddress,
            mailbox: routerConfig[currentChain].mailbox,
            foreignDeployment:
              foreignDeploymentByChain[maybeNonRebalanceableChain],
            owner,
            gas: gasByChain[maybeNonRebalanceableChain],
          },
        ];
      },
    ),
  );
};
