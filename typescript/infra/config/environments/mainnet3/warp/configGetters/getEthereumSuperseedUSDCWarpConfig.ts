import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenConfig,
  HypTokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// TODO: Update to use their safes
const owners = {
  ethereum: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  superseed: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  base: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  ink: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  optimism: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  arbitrum: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  solanamainnet: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumSuperseedUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: owners.superseed,
    type: TokenType.collateralFiat,
    token: '0xc316c8252b5f2176d0135ebb0999e99296998f2e',
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
  };

  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    owner: owners.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
  };

  const ink: HypTokenRouterConfig = {
    ...routerConfig.ink,
    owner: owners.ink,
    type: TokenType.collateral,
    token: tokens.ink.USDCe,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: '7aM3itqXToHXhdR97EwJjZc7fay6uBszhUs1rzJm3tto',
  };

  return {
    ethereum,
    superseed,
    arbitrum,
    base,
    optimism,
    ink,
    solanamainnet,
  };
};

export const getEthereumSuperseedUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ethereum, superseed, arbitrum, base, optimism, ink, solanamainnet } =
    await getEthereumSuperseedUSDCWarpConfig(routerConfig);

  return {
    ethereum,
    arbitrum,
    base,
    optimism,
    ink,
    solanamainnet: {
      ...solanamainnet,
      foreignDeployment: '8UUnM8wheNwAf3KM65Yx72Mq8mSAHf33GUwEp3MAyQX1',
    },
    superseed: {
      ...superseed,
      token: '0x99a38322cAF878Ef55AE4d0Eda535535eF8C7960',
    } as Extract<HypTokenConfig, { type: TokenType.collateralFiat }>,
  };
};
