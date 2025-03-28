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

export const getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
    abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      ...abacusWorksEnvOwnerConfig.arbitrum,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.arbitrum,
        address: '0x6701d503369cf6aA9e5EdFfEBFA40A2ffdf3dB21',
      },
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      ...abacusWorksEnvOwnerConfig.ethereum,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.ethereum,
        address: '0xA92D6084709469A2B2339919FfC568b7C5D7888D',
      },
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: HypTokenRouterConfig = {
      ...routerConfig.mantle,
      ...abacusWorksEnvOwnerConfig.mantle,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.mantle,
        address: '0x633268639892C73Fa7340Ec1da4e397cf3913c8C',
      },
      type: TokenType.collateral,
      token: tokens.mantle.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: HypTokenRouterConfig = {
      ...routerConfig.mode,
      ...abacusWorksEnvOwnerConfig.mode,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.mode,
        address: '0x633268639892C73Fa7340Ec1da4e397cf3913c8C',
      },
      type: TokenType.collateral,
      token: tokens.mode.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      ...abacusWorksEnvOwnerConfig.polygon,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.polygon,
        address: '0x5DBeAEC137d1ef9a240599656073Ae3E717fae3c',
      },
      type: TokenType.collateral,
      token: tokens.polygon.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: HypTokenRouterConfig = {
      ...routerConfig.scroll,
      ...abacusWorksEnvOwnerConfig.scroll,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.scroll,
        address: '0x81Db8B4Bc6F2e95781eeA2a21D0A453Ac046eFc0',
      },
      type: TokenType.collateral,
      token: tokens.scroll.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.zeronetwork,
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
