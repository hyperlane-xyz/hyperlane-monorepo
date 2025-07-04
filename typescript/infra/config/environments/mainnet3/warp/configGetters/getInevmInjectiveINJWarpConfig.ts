import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getInevmInjectiveINJWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const injectiveRouter = 'inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k';

  const injective: HypTokenRouterConfig = {
    ...routerConfig.injective,
    ...abacusWorksEnvOwnerConfig.injective,
    type: TokenType.native,
    foreignDeployment: injectiveRouter,
    gas: 68000,
  };

  const inevm: HypTokenRouterConfig = {
    ...routerConfig.inevm,
    ...abacusWorksEnvOwnerConfig.inevm,
    type: TokenType.native,
  };

  return {
    injective,
    inevm,
  };
};
