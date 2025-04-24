import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { timelocks } from '../../owners.js';

export const getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
    abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      owner: abacusWorksEnvOwnerConfig.arbitrum.owner,
      proxyAdmin: {
        address: '0x6701d503369cf6aA9e5EdFfEBFA40A2ffdf3dB21',
        owner: timelocks.arbitrum,
      },
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.ethereum.owner,
        address: '0xA92D6084709469A2B2339919FfC568b7C5D7888D',
      },
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const mantle: HypTokenRouterConfig = {
      ...routerConfig.mantle,
      owner: abacusWorksEnvOwnerConfig.mantle.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.mantle.owner,
        address: '0x633268639892C73Fa7340Ec1da4e397cf3913c8C',
      },
      type: TokenType.collateral,
      token: tokens.mantle.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const mode: HypTokenRouterConfig = {
      ...routerConfig.mode,
      owner: abacusWorksEnvOwnerConfig.mode.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.mode.owner,
        address: '0x633268639892C73Fa7340Ec1da4e397cf3913c8C',
      },
      type: TokenType.collateral,
      token: tokens.mode.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      owner: abacusWorksEnvOwnerConfig.polygon.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.polygon.owner,
        address: '0x5DBeAEC137d1ef9a240599656073Ae3E717fae3c',
      },
      type: TokenType.collateral,
      token: tokens.polygon.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const scroll: HypTokenRouterConfig = {
      ...routerConfig.scroll,
      owner: abacusWorksEnvOwnerConfig.scroll.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.scroll.owner,
        address: '0x81Db8B4Bc6F2e95781eeA2a21D0A453Ac046eFc0',
      },
      type: TokenType.collateral,
      token: tokens.scroll.USDT,
      interchainSecurityModule: ISM_CONFIG,
      remoteRouters: {
        zeronetwork: { address: '0x36dcfe3A0C6e0b5425F298587159249d780AAfab' },
      },
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
        address: '0xa3F188BDd6e3894b393e12396347545bC47E7B0e',
      },
      type: TokenType.synthetic,
      interchainSecurityModule: ISM_CONFIG,
    };

    return {
      arbitrum,
      ethereum,
      mantle,
      mode,
      polygon,
      scroll,
      zeronetwork,
    };
  };
