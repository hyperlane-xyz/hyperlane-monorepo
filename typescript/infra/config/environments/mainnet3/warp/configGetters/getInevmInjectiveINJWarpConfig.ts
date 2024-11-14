import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getInevmInjectiveINJWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const injectiveRouter = 'inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k';

  const injective: TokenRouterConfig = {
    ...routerConfig.injective,
    ...abacusWorksEnvOwnerConfig.injective,
    type: TokenType.native,
    foreignDeployment: injectiveRouter,
  };

  const inevm: TokenRouterConfig = {
    ...routerConfig.inevm,
    ...abacusWorksEnvOwnerConfig.inevm,
    type: TokenType.native,
  };

  return {
    injective,
    inevm,
  };
};
