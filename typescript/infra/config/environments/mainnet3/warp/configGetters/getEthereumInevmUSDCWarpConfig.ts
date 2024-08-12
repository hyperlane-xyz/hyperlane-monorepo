import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getEthereumInevmUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // TODO: seems to be evidence that this ISM should have been set https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/3233/commits/dc8d50c9c49cdea8417fbe9dad090dc13f078fff
  // checker tooling suggests that it has not been set zero address for ISM is being used
  // run yarn tsx ./scripts/check-deploy.ts -e mainnet3 -f ethereum -m warp --warpRouteId USDC/ethereum-inevm

  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['inevm'],
    defaultMultisigConfigs,
  ).inevm;

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    hook: '0xb87AC8EA4533AE017604E44470F7c1E550AC6F10', // aggregation of IGP and Merkle, arbitrary config not supported for now
    interchainSecurityModule: ismConfig,
  };

  const inevm: TokenRouterConfig = {
    ...routerConfig.inevm,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    inevm,
  };
};
