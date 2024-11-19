import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

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
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const mode: TokenRouterConfig = {
    ...routerConfig.mode,
    type: TokenType.collateral,
    token: collateralAddresses.mode,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const scroll: TokenRouterConfig = {
    ...routerConfig.scroll,
    type: TokenType.collateral,
    token: collateralAddresses.scroll,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    mode,
    scroll,
    zeronetwork,
  };
};
