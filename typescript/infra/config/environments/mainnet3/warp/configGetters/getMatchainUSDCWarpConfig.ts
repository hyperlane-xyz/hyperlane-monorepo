import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

const deploymentChains = ['base', 'bsc', 'ethereum', 'matchain'] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const owners: Record<DeploymentChain, string> = {
  base: '0x3941e287a5e815177E5eA909EDb357fc7F7738C5',
  bsc: '0x489145FABcc90d09feCa3285BDd0A64cB2FB8d8c',
  ethereum: '0x3941e287a5e815177E5eA909EDb357fc7F7738C5',
  matchain: '0x485f48CdCc2F27ACE7B4BE6398ef1dD5002b65F5',
};

const usdcTokenAddresses: Record<DeploymentChain, string> = {
  base: tokens.base.USDC,
  bsc: tokens.bsc.USDC,
  ethereum: tokens.ethereum.USDC,
  matchain: '0x679Dc08cC3A4acFeea2f7CAFAa37561aE0b41Ce7', // Not in common tokens yet
};

export const getMatchainUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner = owners[currentChain];
        assert(owner, `Owner not found for chain ${currentChain}`);

        const baseConfig = {
          ...routerConfig[currentChain],
          owner,
        };

        if (currentChain === 'matchain') {
          return [
            currentChain,
            {
              ...baseConfig,
              type: TokenType.collateralFiat,
              token: usdcTokenAddresses[currentChain],
              decimals: 18,
            },
          ];
        }

        if (currentChain === 'base') {
          return [
            currentChain,
            {
              ...baseConfig,
              type: TokenType.collateral,
              token: usdcTokenAddresses[currentChain],
              name: 'USDC',
              symbol: 'USDC',
              decimals: 6,
              scale: 1000000000000,
            },
          ];
        }

        if (currentChain === 'ethereum') {
          return [
            currentChain,
            {
              ...baseConfig,
              type: TokenType.collateral,
              token: usdcTokenAddresses[currentChain],
              name: 'USDC',
              symbol: 'USDC',
              decimals: 6,
              scale: 1000000000000,
            },
          ];
        }

        if (currentChain === 'bsc') {
          return [
            currentChain,
            {
              ...baseConfig,
              type: TokenType.collateral,
              token: usdcTokenAddresses[currentChain],
              decimals: 18,
            },
          ];
        }

        throw new Error(`Unsupported chain: ${currentChain}`);
      },
    ),
  );
};

export const getMatchainUSDCStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(owners);
