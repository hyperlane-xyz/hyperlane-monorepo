import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const owners = {
  base: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  ethereum: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  superseed: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
};

export const getBaseEthereumSuperseedCBBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.cbBTC,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.cbBTC,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: owners.superseed,
    type: TokenType.collateralFiat,
    token: '0x6f36dbd829de9b7e077db8a35b480d4329ceb331',
  };

  return {
    base,
    ethereum,
    superseed,
  };
};
