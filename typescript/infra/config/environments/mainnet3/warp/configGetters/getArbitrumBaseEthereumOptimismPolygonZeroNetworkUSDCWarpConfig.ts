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
import { timelocks } from '../../owners.js';

export const getArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDCWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
    abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const ISM_CONFIG = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      owner: abacusWorksEnvOwnerConfig.arbitrum.owner,
      proxyAdmin: {
        address: '0x02317D525FA7ceb5ea388244b4618f0c8Ac1CeC2',
        owner: timelocks.arbitrum,
      },
      type: TokenType.collateral,
      token: tokens.arbitrum.USDC,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        1135: { address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0' },
        543210: { address: '0xbb967d98313EDF91751651C0E66ef8A8B7BeD9e1' },
      },
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      owner: abacusWorksEnvOwnerConfig.base.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.base.owner,
        address: '0xB6E9331576C5aBF69376AF6989eA61b7C7ea67F1',
      },
      type: TokenType.collateral,
      token: tokens.base.USDC,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        1135: { address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0' },
        543210: { address: '0xbb967d98313EDF91751651C0E66ef8A8B7BeD9e1' },
      },
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      owner: abacusWorksEnvOwnerConfig.optimism.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.optimism.owner,
        address: '0xca9e64761C97b049901dF4E7a5926464969528b1',
      },
      type: TokenType.collateral,
      token: tokens.optimism.USDC,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        1135: { address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0' },
        543210: { address: '0xbb967d98313EDF91751651C0E66ef8A8B7BeD9e1' },
      },
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      owner: abacusWorksEnvOwnerConfig.polygon.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.polygon.owner,
        address: '0x7fd5be37d560626625f395A2e6E30eA89150cc98',
      },
      type: TokenType.collateral,
      token: tokens.polygon.USDC,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        1135: { address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0' },
        543210: { address: '0xbb967d98313EDF91751651C0E66ef8A8B7BeD9e1' },
      },
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
        address: '0x6E906d8AeEBE9025a410887EAafc58C2561705e0',
      },
      type: TokenType.collateral,
      token: tokens.zeronetwork.USDC,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.ethereum.owner,
        address: '0x81063D413Ed6Eac3FCf0521eea14906fD27fEb1A',
      },
      type: TokenType.collateral,
      token: tokens.ethereum.USDC,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        1135: { address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0' },
        543210: { address: '0xbb967d98313EDF91751651C0E66ef8A8B7BeD9e1' },
      },
    };

    const lisk: HypTokenRouterConfig = {
      ...routerConfig.lisk,
      owner: abacusWorksEnvOwnerConfig.lisk.owner,
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
