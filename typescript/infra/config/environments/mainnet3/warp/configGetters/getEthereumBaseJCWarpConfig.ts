import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getBaseZeronetworkJackieChainWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: DEPLOYER,
    type: TokenType.collateral,
    token: tokens.base.jc,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: HypTokenRouterConfig = {
    ...routerConfig.zeronetwork,
    owner: DEPLOYER,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    base,
    zeronetwork,
  };
};
