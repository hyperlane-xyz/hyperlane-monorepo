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

// pumpBTC team
const ethereumOwner = '0x77A0545Dc1Dc6bAee8d9c1d436c6688a75Ae5777';
const seiOwner = '0x14A359aE2446eaC89495b3F28b7a29cE2A17f392';

export const getEthereumSeiPumpBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    proxyAdmin: {
      // Address explicitly specified as move away from the AW proxy admin
      address: '0x64d4ba42f033927ca3babbbebaa11ac8caed9472',
      owner: ethereumOwner,
    },
    type: TokenType.collateral,
    token: tokens.ethereum.pumpBTCsei,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const sei: HypTokenRouterConfig = {
    ...routerConfig.sei,
    ...getOwnerConfigForAddress(seiOwner),
    proxyAdmin: {
      // Address explicitly specified as move away from the AW proxy admin
      address: '0x932a0a357CbE9a06c0FCec8C56335DA162c5D071',
      owner: seiOwner,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    sei,
  };
};
