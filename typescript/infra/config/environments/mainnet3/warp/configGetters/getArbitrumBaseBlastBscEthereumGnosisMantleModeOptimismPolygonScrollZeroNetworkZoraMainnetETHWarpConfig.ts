import { ethers } from 'ethers';

import {
  ChainMap,
  IsmConfig,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
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
  ): Promise<ChainMap<TokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      ...abacusWorksEnvOwnerConfig.arbitrum,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: TokenRouterConfig = {
      ...routerConfig.base,
      ...abacusWorksEnvOwnerConfig.base,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: TokenRouterConfig = {
      ...routerConfig.blast,
      ...abacusWorksEnvOwnerConfig.blast,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: TokenRouterConfig = {
      ...routerConfig.bsc,
      ...abacusWorksEnvOwnerConfig.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      ...abacusWorksEnvOwnerConfig.ethereum,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: TokenRouterConfig = {
      ...routerConfig.gnosis,
      ...abacusWorksEnvOwnerConfig.gnosis,
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      ...abacusWorksEnvOwnerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      ...abacusWorksEnvOwnerConfig.mode,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: TokenRouterConfig = {
      ...routerConfig.optimism,
      ...abacusWorksEnvOwnerConfig.optimism,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      ...abacusWorksEnvOwnerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      ...abacusWorksEnvOwnerConfig.scroll,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: TokenRouterConfig = {
      ...routerConfig.zoramainnet,
      ...abacusWorksEnvOwnerConfig.zoramainnet,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const lisk: TokenRouterConfig = {
      ...routerConfig.lisk,
      ...abacusWorksEnvOwnerConfig.lisk,
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
