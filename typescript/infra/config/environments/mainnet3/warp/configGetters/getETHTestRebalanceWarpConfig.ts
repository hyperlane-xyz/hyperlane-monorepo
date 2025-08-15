import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

import { getETHRebalancingBridgesConfigFor } from './utils.js';

const deploymentChains = ['arbitrum', 'optimism', 'base'] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const syntheticChain: DeploymentChain = 'base';

export const getETHRebalanceableTestWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain = getETHRebalancingBridgesConfigFor(
    deploymentChains.filter((chain) => chain !== syntheticChain),
  );

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner = DEPLOYER;

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
            type: TokenType.native,
            mailbox: routerConfig[currentChain].mailbox,
            owner,
            allowedRebalancers,
            allowedRebalancingBridges,
          },
        ];
      },
    ),
  );
};
