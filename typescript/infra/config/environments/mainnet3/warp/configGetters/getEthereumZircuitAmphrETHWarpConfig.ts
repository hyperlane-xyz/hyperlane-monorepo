import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

const ethereumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const zircuitOwner = '0xD0673e7F3FB4037CA79F53d2d311D0e017d39963';
const amphrEthCollateralAddress = '0x5fD13359Ba15A84B76f7F87568309040176167cd';

export const getEthereumZircuitAmphrETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: amphrEthCollateralAddress,
    owner: ethereumOwner,
    interchainSecurityModule: ethers.constants.AddressZero,
    ownerOverrides: {
      proxyAdmin: ethereumOwner,
    },
  };

  const zircuit: TokenRouterConfig = {
    ...routerConfig.zircuit,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: zircuitOwner,
    ownerOverrides: {
      proxyAdmin: zircuitOwner,
    },
  };

  return {
    ethereum,
    zircuit,
  };
};
