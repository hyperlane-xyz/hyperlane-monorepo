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

export const getEclipseStrideStTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    owner: awSafes.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'tKUHyJ5NxhnwU94JUmzh1ekukDcHHX8mZF6fqxbMwX6',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  const stride: HypTokenRouterConfig = {
    ...routerConfig.stride,
    ...getOwnerConfigForAddress(strideOwner),
    type: TokenType.collateral,
    foreignDeployment:
      'stride134axwdlam929m3mar3wv95nvkyep7mr87ravkqcpf8dfe3v0pjlqwrw6ee',
    token:
      'ibc/BF3B4F53F3694B66E13C23107C84B6485BD2B96296BB7EC680EA77BBA75B4801',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
