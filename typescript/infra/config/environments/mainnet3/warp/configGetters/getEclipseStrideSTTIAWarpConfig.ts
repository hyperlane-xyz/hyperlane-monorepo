import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Stride team
const strideOwner = 'stride1k8c2m5cn322akk5wy8lpt87dd2f4yh9azg7jlh';

export const getEclipseStrideTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    owner: awSafes.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'BpXHAiktwjx7fN6M9ST9wr6qKAsH27wZFhdHEhReJsR6',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  const stride: HypTokenRouterConfig = {
    ...routerConfig.stride,
    ...getOwnerConfigForAddress(strideOwner),
    type: TokenType.collateral,
    foreignDeployment:
      'stride1pvtesu3ve7qn7ctll2x495mrqf2ysp6fws68grvcu6f7n2ajghgsh2jdj6',
    token: 'stutia',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
