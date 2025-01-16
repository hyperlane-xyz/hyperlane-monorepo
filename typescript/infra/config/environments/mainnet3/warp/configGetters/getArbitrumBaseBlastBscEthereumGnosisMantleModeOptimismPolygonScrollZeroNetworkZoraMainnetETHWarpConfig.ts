import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Decent team wallet
const DECENT_OWNER = '0x5b234E48a3dD867f0DdA9DAd1DBd554eCE823cA0';

export const getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: HypTokenRouterConfig = {
      ...routerConfig.blast,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: HypTokenRouterConfig = {
      ...routerConfig.bsc,
      owner: DECENT_OWNER,
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: HypTokenRouterConfig = {
      ...routerConfig.gnosis,
      owner: DECENT_OWNER,
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: HypTokenRouterConfig = {
      ...routerConfig.mantle,
      owner: DECENT_OWNER,
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: HypTokenRouterConfig = {
      ...routerConfig.mode,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      owner: DECENT_OWNER,
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: HypTokenRouterConfig = {
      ...routerConfig.scroll,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: HypTokenRouterConfig = {
      ...routerConfig.zoramainnet,
      owner: DECENT_OWNER,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const lisk: HypTokenRouterConfig = {
      ...routerConfig.lisk,
      owner: DECENT_OWNER,
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
