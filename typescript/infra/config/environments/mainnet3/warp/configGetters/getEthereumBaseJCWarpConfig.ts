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

export const getBaseZeronetworkJackieChainWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: abacusWorksEnvOwnerConfig.base.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.base.owner,
      address: '0xdF84DA358Ab678024649fCa37f7207FE4455896A',
    },
    type: TokenType.collateral,
    token: tokens.base.jc,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: HypTokenRouterConfig = {
    ...routerConfig.zeronetwork,
    owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.base.owner,
      address: '0x175B542ff2583f6c44059233Ed65f29e2fcAb930',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    base,
    zeronetwork,
  };
};
