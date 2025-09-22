import {
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { usdcTokenAddresses } from '../cctp.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

type DeploymentChains<T> = {
  arbitrum: T;
  base: T;
  polygon: T;
  pulsechain: T;
  ethereum: T;
};

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  base: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  polygon: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  ethereum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  pulsechain: '0x703cf58975B14142eD0Ba272555789610c85520c',
};

export const getRebalanceableCollateralTokenConfigForChain = (
  currentChain: keyof typeof usdcTokenAddresses,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: ChainMap<Address>,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const usdcTokenAddress = usdcTokenAddresses[currentChain];
  assert(
    usdcTokenAddress,
    `USDC token address not found for chain ${currentChain}`,
  );

  const currentRebalancingConfig = getUSDCRebalancingBridgesConfigFor(
    Object.keys(ownersByChain),
  )[currentChain];
  assert(
    currentRebalancingConfig,
    `Rebalancing config not found for chain ${currentChain}`,
  );

  const { allowedRebalancers, allowedRebalancingBridges } =
    currentRebalancingConfig;

  return {
    type: TokenType.collateral,
    token: usdcTokenAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
    allowedRebalancers,
    allowedRebalancingBridges,
  };
};

export const getSyntheticTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  return {
    type: TokenType.synthetic,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

export const getPulsechainUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig: DeploymentChains<HypTokenRouterConfig> = {
    arbitrum: getRebalanceableCollateralTokenConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
    ),
    base: getRebalanceableCollateralTokenConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
    ),
    ethereum: getRebalanceableCollateralTokenConfigForChain(
      'ethereum',
      routerConfig,
      ownersByChain,
    ),
    polygon: getRebalanceableCollateralTokenConfigForChain(
      'polygon',
      routerConfig,
      ownersByChain,
    ),
    pulsechain: getSyntheticTokenConfigForChain(
      'pulsechain',
      routerConfig,
      ownersByChain,
    ),
  };

  return deployConfig;
};
