import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import {
  SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  STARKNET_WARP_ROUTE_HANDLER_GAS_AMOUNT,
} from '../consts.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
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
  arbitrum: DEPLOYER,
  base: DEPLOYER,
  ethereum: DEPLOYER,
  mode: DEPLOYER,
  paradex: '0x041e326bf455461926b9c334d02039cb0d4f09698c5158ef8d939b33b240a0e0',
  solanamainnet: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
  starknet:
    '0x06ae465e0c05735820a75500c40cb4dabbe46ebf1f1665f9ba3f9a7dcc78a6d1',
};

export const getParadexUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain =
    getUSDCRebalancingBridgesConfigFor(deploymentChains);

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
