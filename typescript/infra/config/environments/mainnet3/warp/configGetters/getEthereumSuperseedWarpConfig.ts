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
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumSuperseedCBBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.cbBTC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: owners.superseed,
    type: TokenType.collateralFiat,
    token: '0x6f36dbd829de9b7e077db8a35b480d4329ceb331',
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    superseed,
  };
};

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

  return {
    ethereum,
    superseed,
    arbitrum,
    base,
    optimism,
    ink,
  };
};

export const getEthereumSuperseedUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ethereum, superseed } = await getEthereumSuperseedUSDCWarpConfig(
    routerConfig,
  );

  return {
    ethereum,
    superseed: {
      ...superseed,
      token: '0x99a38322cAF878Ef55AE4d0Eda535535eF8C7960',
    } as Extract<HypTokenConfig, { type: TokenType.collateralFiat }>,
  };
};
