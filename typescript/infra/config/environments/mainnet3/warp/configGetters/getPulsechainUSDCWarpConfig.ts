import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { usdcTokenAddresses } from '../cctp.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'polygon',
  'pulsechain',
  'ethereum',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const syntheticChain: DeploymentChain = 'pulsechain';

// SAFE wallets from the team
const ownersByChain: Record<DeploymentChain, Address> = {
  arbitrum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  base: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  polygon: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  ethereum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  pulsechain: '0x703cf58975B14142eD0Ba272555789610c85520c',
};

export const getPulsechainUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfigByChain =
    getUSDCRebalancingBridgesConfigFor(deploymentChains);

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner = ownersByChain[currentChain];
        assert(owner, `Owner not found for chain ${currentChain}`);

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
          },
        ];
      },
    ),
  );
};
