import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
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
  ): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.arbitrum,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      // TODO: remove once we transfer ownership of the proxy admin
      ownerOverrides: abacusWorksEnvOwnerConfig.arbitrum.ownerOverrides,
      // END TODO
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.base,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.blast,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.bsc,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.ethereum,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.gnosis,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.mantle,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.mode,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.optimism,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.polygon,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.scroll,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.zeronetwork,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: HypTokenRouterConfigMailboxOptional = {
      ...routerConfig.zoramainnet,
      ...getOwnerConfigForAddress(DECENT_OWNER),
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const lisk: HypTokenRouterConfigMailboxOptional = {
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
