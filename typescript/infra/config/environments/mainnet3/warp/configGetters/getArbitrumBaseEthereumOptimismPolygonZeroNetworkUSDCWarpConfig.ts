import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG = ethers.constants.AddressZero;

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...abacusWorksEnvOwnerConfig.arbitrum,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.arbitrum,
      address: '0x02317D525FA7ceb5ea388244b4618f0c8Ac1CeC2',
    },
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...abacusWorksEnvOwnerConfig.base,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.base,
      address: '0xB6E9331576C5aBF69376AF6989eA61b7C7ea67F1',
    },
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    ...abacusWorksEnvOwnerConfig.optimism,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.optimism,
      address: '0xca9e64761C97b049901dF4E7a5926464969528b1',
    },
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const polygon: HypTokenRouterConfig = {
    ...routerConfig.polygon,
    ...abacusWorksEnvOwnerConfig.polygon,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.polygon,
      address: '0x7fd5be37d560626625f395A2e6E30eA89150cc98',
    },
    type: TokenType.collateral,
    token: tokens.polygon.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: HypTokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0x6E906d8AeEBE9025a410887EAafc58C2561705e0',
    },
    type: TokenType.collateral,
    token: tokens.zeronetwork.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.ethereum,
      address: '0x81063D413Ed6Eac3FCf0521eea14906fD27fEb1A',
    },
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const lisk: HypTokenRouterConfig = {
    ...routerConfig.lisk,
    ...abacusWorksEnvOwnerConfig.lisk,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.lisk,
      address: '0x81Db8B4Bc6F2e95781eeA2a21D0A453Ac046eFc0',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    arbitrum,
    base,
    ethereum,
    optimism,
    polygon,
    zeronetwork,
    lisk,
  };
};
