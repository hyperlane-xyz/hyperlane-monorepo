import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Decent team wallet
const DECENT_OWNER = '0x5b234E48a3dD867f0DdA9DAd1DBd554eCE823cA0';

export const getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
    abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      // TODO: remove once we transfer ownership of the proxy admin
      ownerOverrides: abacusWorksEnvOwnerConfig.arbitrum.ownerOverrides,
      // END TODO
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: HypTokenRouterConfig = {
      ...routerConfig.blast,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: HypTokenRouterConfig = {
      ...routerConfig.bsc,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: HypTokenRouterConfig = {
      ...routerConfig.gnosis,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: HypTokenRouterConfig = {
      ...routerConfig.mantle,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: HypTokenRouterConfig = {
      ...routerConfig.mode,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: HypTokenRouterConfig = {
      ...routerConfig.scroll,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: HypTokenRouterConfig = {
      ...routerConfig.zeronetwork,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: HypTokenRouterConfig = {
      ...routerConfig.zoramainnet,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const lisk: HypTokenRouterConfig = {
      ...routerConfig.lisk,
      ...getOwnerConfigForAddress(DECENT_OWNER),
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
