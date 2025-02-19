import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumHyperevmETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    type: TokenType.native,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      address: '0x98C67C12e1DAA770AE6bcc6839E2A05315447FFF',
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
      address: '0xe6fC77B08b457A29747682aB1dBfb32AF4A1A999',
    },
  };

  return {
    ethereum,
    hyperevm,
  };
};
