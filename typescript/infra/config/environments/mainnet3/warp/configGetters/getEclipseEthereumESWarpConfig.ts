import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const eclipseTeamMultiSigs = {
  eclipsemainnet: '3KK8L7UYd7NV575w9vWR2o1kNqdSFvEPUwcTA5353cax',
  ethereum: '0x7B2c1CbB33c53c3C6a695e36096AD2cfCE1c0efC',
  solanamainnet: 'AuUJ9cFh1iGPpQfmyFfD3AJVUrGgNHJ6vqMNSPJn4Ekb',
};

export const getEclipseEthereumESWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    eclipsemainnet: {
      mailbox: routerConfig.eclipsemainnet.mailbox,
      owner: eclipseTeamMultiSigs.eclipsemainnet,
      type: TokenType.synthetic,
      foreignDeployment: '2JvSu7PzquY2b8NDZbnupFZ1jezqMBtNUhi7TuU3GQJD',
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
    solanamainnet: {
      foreignDeployment: '9Cu9VqDPPzntFZMar4gCdw6EGL3RbofLEqyh6WKSZKGm',
      mailbox: routerConfig.solanamainnet.mailbox,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      owner: eclipseTeamMultiSigs.solanamainnet,
      type: TokenType.synthetic,
    },
    ethereum: {
      mailbox: routerConfig.ethereum.mailbox,
      type: TokenType.collateral,
      owner: eclipseTeamMultiSigs.ethereum,
      token: tokens.ethereum.ES,
    },
  };
};
