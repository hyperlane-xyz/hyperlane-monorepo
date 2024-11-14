import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// Lumia Team
const owner = '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863';
const ownerConfig = getOwnerConfigForAddress(owner);

export const getEthereumBscLUMIAWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...ownerConfig,
    type: TokenType.collateral,
    token: '0xD9343a049D5DBd89CD19DC6BcA8c48fB3a0a42a7',
  };

  const bsc: TokenRouterConfig = {
    ...routerConfig.bsc,
    ...ownerConfig,
    type: TokenType.synthetic,
  };

  const lumia: TokenRouterConfig = {
    ...routerConfig.lumia,
    ...ownerConfig,
    type: TokenType.native,
    // As this has been removed from the registry in https://github.com/hyperlane-xyz/hyperlane-registry/pull/348,
    // we must specify this explicitly.
    mailbox: '0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7',
    proxyAdmin: {
      owner: owner,
      address: '0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D',
    },
  };

  return {
    ethereum,
    bsc,
    lumia,
  };
};
