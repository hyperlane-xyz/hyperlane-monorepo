import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumHyperevmWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      address: '0x9CBc9Ac08EDadA05Eb533135d8a76E402a867C46',
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
      address: '0xa3D9cfa4220d6a5ba7b9067D33ebEdbF2DE6F1CF',
    },
  };

  return {
    ethereum,
    hyperevm,
  };
};
