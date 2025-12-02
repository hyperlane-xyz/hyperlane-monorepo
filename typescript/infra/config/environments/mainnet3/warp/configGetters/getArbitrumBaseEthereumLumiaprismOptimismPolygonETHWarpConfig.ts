import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

const safeOwners: ChainMap<Address> = {
  arbitrum: '0xc8A9Dea7359Bd6FDCAD3B8EDE108416C25cF4CE9',
  ethereum: '0xb10B260fBf5F33CC5Ff81761e090aeCDffcb1fd5',
  base: '0xC92aB408512defCf1938858E726dc5C0ada9175a',
  lumiaprism: '0x1b06089dA471355F8F05C7A6d8DE1D9dAC397629',
  optimism: '0x914931eBb5638108651455F50C1F784d3E5fd3EC',
  polygon: '0x7a412dD3812369226cd42023FC9301A66788122e',
};

export const getArbitrumBaseEthereumLumiaprismOptimismPolygonETHWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      owner: safeOwners.arbitrum,
      type: TokenType.native,
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      owner: safeOwners.base,
      type: TokenType.native,
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      owner: safeOwners.ethereum,
      type: TokenType.native,
    };

    const lumiaprism: HypTokenRouterConfig = {
      ...routerConfig.lumiaprism,
      owner: safeOwners.lumiaprism,
      type: TokenType.synthetic,
      symbol: 'WETH',
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      owner: safeOwners.optimism,
      type: TokenType.native,
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      owner: safeOwners.polygon,
      token: tokens.polygon.WETH,
      type: TokenType.collateral,
    };

    return {
      arbitrum,
      base,
      ethereum,
      lumiaprism,
      optimism,
      polygon,
    };
  };

export const getArbitrumBaseEthereumLumiaprismOptimismPolygonETHGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(safeOwners);
