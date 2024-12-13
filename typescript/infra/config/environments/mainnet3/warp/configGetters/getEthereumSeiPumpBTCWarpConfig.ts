import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const ethereumOwner = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const seiOwner = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

export const getEthereumSeiPumpBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    type: TokenType.collateral,
    token: tokens.ethereum.pumpBTCsei,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const sei: HypTokenRouterConfig = {
    ...routerConfig.sei,
    ...getOwnerConfigForAddress(seiOwner),
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    sei,
  };
};
