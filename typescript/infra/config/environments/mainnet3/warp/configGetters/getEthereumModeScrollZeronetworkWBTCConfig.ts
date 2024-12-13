import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const collateralAddresses: ChainMap<Address> = {
  ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  mode: '0xcDd475325D6F564d27247D1DddBb0DAc6fA0a5CF',
  scroll: '0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1',
};

export const getEthereumModeScrollZeronetworkWBTCConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.ethereum,
      address: '0x67eB139588813Eb311C539Ac51C2638f3A318Ba7',
    },
    type: TokenType.collateral,
    token: collateralAddresses.ethereum,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const mode: TokenRouterConfig = {
    ...routerConfig.mode,
    ...abacusWorksEnvOwnerConfig.mode,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.mode,
      address: '0xEfad3f079048bE2765b6bCfAa3E9d99e9A2C3Df6',
    },
    type: TokenType.collateral,
    token: collateralAddresses.mode,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const scroll: TokenRouterConfig = {
    ...routerConfig.scroll,
    ...abacusWorksEnvOwnerConfig.scroll,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.scroll,
      address: '0xD5EBCD7473bf128Ac6B2EB487c707Aa33436e5Dd',
    },
    type: TokenType.collateral,
    token: collateralAddresses.scroll,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0x62F55b3a17267bf704D1E1824D4a2316e4fd9Ba3',
    },
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
