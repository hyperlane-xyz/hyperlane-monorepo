import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

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

export const getSubtensorUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain =
    getUSDCRebalancingBridgesConfigFor(deploymentChains);

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner =
          awIcas[currentChain] ??
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
      },
    ),
  );
};
