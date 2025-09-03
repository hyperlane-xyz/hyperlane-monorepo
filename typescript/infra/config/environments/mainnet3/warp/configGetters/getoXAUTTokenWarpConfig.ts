import { ethers } from 'ethers';

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

const chainsToDeploy = ['avalanche', 'base', 'celo', 'ethereum', 'worldchain'];
const ownerMap: ChainMap<string> = objFilter(
  awSafes,
  (chain, safe): safe is string => chainsToDeploy.includes(chain),
);
const tokenMetadata: ChainMap<{
  type: TokenType.XERC20 | TokenType.XERC20Lockbox;
  token: string;
}> = {
  avalanche: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
  },
  base: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
  },
  celo: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
  },
  ethereum: {
    type: TokenType.XERC20Lockbox,
    token: '0x0797c6f55f5c9005996A55959A341018cF69A963',
  },
  worldchain: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
  },
};

export const getoXAUTTokenProductionWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const configs: ChainMap<HypTokenRouterConfig> = {};

  for (const chain of chainsToDeploy) {
    configs[chain] = {
      type: tokenMetadata[chain].type,
      mailbox: routerConfig[chain].mailbox,
      owner: ownerMap[chain],
      ownerOverrides: {
        collateralToken: ownerMap[chain],
      },
      token: tokenMetadata[chain].token,
    };
  }

  return configs;
};

export const getoXAUTGnosisSafeSubmitterStrategyConfig =
  getGnosisSafeSubmitterStrategyConfigGenerator(ownerMap);
