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
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Redacted / Dinero team
const ethereumOwner = '0xA52Fd396891E7A74b641a2Cb1A6999Fcf56B077e';
const eclipseOwner = 'BwYL3jLky8oHLeQp1S48cVRfZPmcXtg1V33UPmnZK3Jk';

export async function getEclipseEthereumApxEthWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...getOwnerConfigForAddress(eclipseOwner),
    type: TokenType.synthetic,
    foreignDeployment: '9pEgj7m2VkwLtJHPtTw5d8vbB7kfjzcXXCRgdwruW7C2',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    type: TokenType.collateral,
    token: tokens.ethereum.apxETH,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
}
