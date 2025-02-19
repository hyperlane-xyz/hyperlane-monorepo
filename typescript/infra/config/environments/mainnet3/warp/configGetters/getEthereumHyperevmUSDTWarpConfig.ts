import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumHyperevmUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    type: TokenType.collateral,
    token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      address: '0x55A426088c37104169F5fB923BdAe17CDF0D6765',
    },
    interchainSecurityModule: ISM_CONFIG,
  };

  const hyperevm: HypTokenRouterConfig = {
    ...routerConfig.hyperevm,
    owner: abacusWorksEnvOwnerConfig.hyperevm.owner,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.hyperevm.owner,
      address: '0xDd2059c375C81638DaB52AF4145d2671C446c5e9',
    },
  };

  return {
    ethereum,
    hyperevm,
  };
};
