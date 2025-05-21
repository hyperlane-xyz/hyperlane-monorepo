import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getArbitrumNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const neutronRouter =
    '910926c4cf95d107237a9cf0b3305fe9c81351ebcba3d218ceb0e4935d92ceac';

  const neutron: HypTokenRouterConfig = {
    ...routerConfig.neutron,
    ...abacusWorksEnvOwnerConfig.neutron,
    type: TokenType.collateral,
    token:
      'ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7',
    foreignDeployment: neutronRouter,
    gas: 600000,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...abacusWorksEnvOwnerConfig.arbitrum,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA.n',
    decimals: 6,
    gas: 600_000,
  };

  return {
    arbitrum,
    neutron,
  };
};
