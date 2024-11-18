import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { safes } from '../../owners.js';

const collateralAddresses: ChainMap<Address> = {
  ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  mode: '0xcDd475325D6F564d27247D1DddBb0DAc6fA0a5CF',
  scroll: '0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1',
};

export const getEthereumModeScrollZeronetworkWBTCConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: collateralAddresses.ethereum,
    interchainSecurityModule: {
      owner: safes.ethereum,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.ethereum,
  };

  const mode: TokenRouterConfig = {
    ...routerConfig.mode,
    type: TokenType.collateral,
    token: collateralAddresses.mode,
    interchainSecurityModule: {
      owner: safes.mode,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.mode,
  };

  const scroll: TokenRouterConfig = {
    ...routerConfig.scroll,
    type: TokenType.collateral,
    token: collateralAddresses.token,
    interchainSecurityModule: {
      owner: safes.scroll,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.scroll,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: {
      owner: safes.zeronetwork,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.zeronetwork,
  };

  return {
    ethereum,
    mode,
    scroll,
    zeronetwork,
  };
};
