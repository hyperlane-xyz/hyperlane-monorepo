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

export const getBaseZeronetworkMigglesConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: abacusWorksEnvOwnerConfig.base.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.base.owner,
      address: '0xAb15bf761276d4a9aaaB14B100c921B417D07BB2',
    },
    type: TokenType.collateral,
    token: tokens.base.miggles,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: HypTokenRouterConfig = {
    ...routerConfig.zeronetwork,
    owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.zeronetwork.owner,
      address: '0xc703DcF5ceaf33214dA115E1c86977A9b5590B59',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    base,
    zeronetwork,
  };
};
