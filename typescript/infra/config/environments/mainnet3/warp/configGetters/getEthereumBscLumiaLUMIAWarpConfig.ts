import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

// Lumia Team
const owner = '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863';

export const getEthereumBscLUMIAWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum = {
    type: TokenType.collateral,
    token: '0xD9343a049D5DBd89CD19DC6BcA8c48fB3a0a42a7',
  };

  const bsc = {
    type: TokenType.synthetic,
  };

  const lumia = {
    type: TokenType.native,
  };

  const configMap = {
    ethereum,
    bsc,
    lumia,
  };

  const merged = objMap(configMap, (chain, config) => ({
    ...routerConfig[chain],
    ...config,
    owner,
  }));

  return merged as ChainMap<TokenRouterConfig>;
};
