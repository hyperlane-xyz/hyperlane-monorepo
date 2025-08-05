import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const turtleOwners = {
  ethereum: '0x2e0355922EF3a5b77d29287C808aEafB4e7f25B2',
  linea: '0x2e0355922EF3a5b77d29287C808aEafB4e7f25B2',
};

export const getEthereumLineaTurtleWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: turtleOwners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.Turtle,
  };

  const linea: HypTokenRouterConfig = {
    ...routerConfig.linea,
    owner: turtleOwners.linea,
    type: TokenType.synthetic,
  };

  return {
    ethereum,
    linea,
  };
};
