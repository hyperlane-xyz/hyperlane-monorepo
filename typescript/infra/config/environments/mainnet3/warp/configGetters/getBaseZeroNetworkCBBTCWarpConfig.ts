import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getBaseZeroNetworkCBBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...abacusWorksEnvOwnerConfig.base,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.base,
      address: '0x0FC41a92F526A8CD22060A4052e156502D6B9db0',
    },
    type: TokenType.collateral,
    token: tokens.base.cbBTC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: HypTokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0xDb0F69187750b52A637938Ea790fAE667123367c',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
    gas: 300000,
  };

  return {
    base,
    zeronetwork,
  };
};
