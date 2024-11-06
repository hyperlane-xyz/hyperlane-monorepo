import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

// Lumia Team
const owner = '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863';

const ownerConfig = {
  owner,
  // The proxyAdmins are warp-route specific
  ownerOverrides: {
    proxyAdmin: owner,
  },
};

export const getEthereumBscLUMIAWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum = {
    type: TokenType.collateral,
    token: '0xD9343a049D5DBd89CD19DC6BcA8c48fB3a0a42a7',
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };

  const bsc = {
    type: TokenType.synthetic,
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };

  const lumia = {
    type: TokenType.native,
    // As this has been removed from the registry in https://github.com/hyperlane-xyz/hyperlane-registry/pull/348,
    // we must specify this explicitly.
    mailbox: '0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7',
    proxyAdmin: '0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D',
  };

  const configMap = {
    ethereum,
    bsc,
    lumia,
  };

  const merged = objMap(configMap, (chain, config) => ({
    ...routerConfig[chain],
    ...config,
    ...ownerConfig,
  }));

  return merged as ChainMap<TokenRouterConfig>;
};
