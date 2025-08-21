import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { objFilter } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getGnosisSafeSubmitterStrategyConfigGenerator } from '../../../utils.js';
import { awSafes } from '../../governance/safe/aw.js';

const chainsToDeploy = ['arbitrum'];
const ownerMap: ChainMap<string> = objFilter(
  awSafes,
  (chain, safe): safe is string => chainsToDeploy.includes(chain),
);

export const getArbitrumCelestiaNeutronTiaWarpConfig = async (
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
    remoteRouters: {
      celestia: {
        address:
          '0x726f757465725f61707000000000000000000000000000010000000000000005',
      },
      neutron: {
        address: neutronRouter,
      },
    },
  };

  const celestia: HypTokenRouterConfig = {
    ...routerConfig.celestia,
    type: TokenType.collateral,
    owner: 'celestia1lcl2vhj4rsalr9qqyg4tkkdk8laqfmz5xqgl5k',
    name: 'TIA',
    symbol: 'TIA',
    token: 'utia',
    decimals: 6,
  };

  return {
    arbitrum,
    celestia,
    neutron,
  };
};

export const getTIAGnosisSafeSubmitterStrategyConfig =
  getGnosisSafeSubmitterStrategyConfigGenerator(ownerMap);
