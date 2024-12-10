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

export const getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig =
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
        address: '0x544BC0f2B619a6920650B0469EA3b6d6Ef3B0b10',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      ...abacusWorksEnvOwnerConfig.base,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.base,
        address: '0x073235Fd88B04e3bA7fAC83146225c0de53E5c31',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: HypTokenRouterConfig = {
      ...routerConfig.blast,
      ...abacusWorksEnvOwnerConfig.blast,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.blast,
        address: '0x9775Dd30480D545b9bEd2A6a1DC344Ffbad9B223',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: HypTokenRouterConfig = {
      ...routerConfig.bsc,
      ...abacusWorksEnvOwnerConfig.bsc,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.bsc,
        address: '0xa0B923456b08944bE30D0F237c041F191Eb0c9D0',
      },
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      ...abacusWorksEnvOwnerConfig.ethereum,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.ethereum,
        address: '0x5E76be0F4e09057D75140216F70fd4cE3365bb29',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: HypTokenRouterConfig = {
      ...routerConfig.gnosis,
      ...abacusWorksEnvOwnerConfig.gnosis,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.gnosis,
        address: '0xe516A113316cFdF8a44e125E4e3970dE6df0cC59',
      },
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: HypTokenRouterConfig = {
      ...routerConfig.mantle,
      ...abacusWorksEnvOwnerConfig.mantle,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.mantle,
        address: '0xEaD68fD6e5A69136CD60De50bF22164658A8E04E',
      },
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: HypTokenRouterConfig = {
      ...routerConfig.mode,
      ...abacusWorksEnvOwnerConfig.mode,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.mode,
        address: '0xEC1f2f8C42c8Ca4C8d15E6a0814667a379aB9b43',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      ...abacusWorksEnvOwnerConfig.optimism,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.optimism,
        address: '0xA900858116D7605a01AfC7595450d8D78555Bc83',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      ...abacusWorksEnvOwnerConfig.polygon,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.polygon,
        address: '0xcA11d580faaE3E6993aA230f437079ac21f3078a',
      },
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: HypTokenRouterConfig = {
      ...routerConfig.scroll,
      ...abacusWorksEnvOwnerConfig.scroll,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.scroll,
        address: '0xA452bDb132Cdf8d11E070786D78907ddB95C5120',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.zeronetwork,
        address: '0xc2caD038236ccDB113C9350EF2551633c65252eF',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: HypTokenRouterConfig = {
      ...routerConfig.zoramainnet,
      ...abacusWorksEnvOwnerConfig.zoramainnet,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.zoramainnet,
        address: '0x9775Dd30480D545b9bEd2A6a1DC344Ffbad9B223',
      },
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const lisk: HypTokenRouterConfig = {
      ...routerConfig.lisk,
      ...abacusWorksEnvOwnerConfig.lisk,
      proxyAdmin: {
        ...abacusWorksEnvOwnerConfig.lisk,
        address: '0x5E76be0F4e09057D75140216F70fd4cE3365bb29',
      },
      type: TokenType.synthetic,
      interchainSecurityModule: ISM_CONFIG,
    };

    return {
      arbitrum,
      base,
      blast,
      bsc,
      gnosis,
      mantle,
      mode,
      optimism,
      polygon,
      scroll,
      zeronetwork,
      zoramainnet,
      ethereum,
      lisk,
    };
  };
