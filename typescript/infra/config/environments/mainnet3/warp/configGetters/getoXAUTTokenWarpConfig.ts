<<<<<<< HEAD
import { ethers } from 'ethers';

=======
>>>>>>> main
import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
<<<<<<< HEAD
=======
  XERC20LimitsTokenConfig,
  XERC20Type,
>>>>>>> main
} from '@hyperlane-xyz/sdk';
import { objFilter } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getGnosisSafeSubmitterStrategyConfigGenerator } from '../../../utils.js';
import { awSafes } from '../../governance/safe/aw.js';

<<<<<<< HEAD
const DEPLOYER = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
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
=======
const chainsToDeploy = ['avalanche', 'base', 'celo', 'ethereum', 'worldchain'];

const EXTRA_BRIDGE_MINT_LIMIT = '10000000000000';
const EXTRA_BRIDGE_BURN_LIMIT = '10000000000000';
const WARP_ROUTE_MINT_LIMIT = '20000000000000';
const WARP_ROUTE_BURN_LIMIT = '20000000000000';
const ownerMap: ChainMap<string> = objFilter(
  awSafes,
  (chain, _safe): _safe is string => chainsToDeploy.includes(chain),
);
const tokenMetadata: ChainMap<XERC20LimitsTokenConfig> = {
  avalanche: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
    xERC20: {
      extraBridges: [
        {
          // Chainlink Pool
          lockbox: '0x18e25Ac83477d7013D43174508B7AE7EC2CE2e08',
          limits: {
            mint: EXTRA_BRIDGE_MINT_LIMIT,
            burn: EXTRA_BRIDGE_BURN_LIMIT,
            type: XERC20Type.Standard,
          },
        },
      ],
      warpRouteLimits: {
        mint: WARP_ROUTE_MINT_LIMIT,
        burn: WARP_ROUTE_BURN_LIMIT,
        type: XERC20Type.Standard,
      },
    },
>>>>>>> main
  },
  base: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
<<<<<<< HEAD
=======
    xERC20: {
      extraBridges: [
        {
          // Chainlink Pool
          lockbox: '0xaF35bef911A5e0be90987cE5070d7c9CbF5cFd3c',
          limits: {
            mint: EXTRA_BRIDGE_MINT_LIMIT,
            burn: EXTRA_BRIDGE_BURN_LIMIT,
            type: XERC20Type.Standard,
          },
        },
      ],
      warpRouteLimits: {
        mint: WARP_ROUTE_MINT_LIMIT,
        burn: WARP_ROUTE_BURN_LIMIT,
        type: XERC20Type.Standard,
      },
    },
>>>>>>> main
  },
  celo: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
<<<<<<< HEAD
=======
    xERC20: {
      warpRouteLimits: {
        mint: WARP_ROUTE_MINT_LIMIT,
        burn: WARP_ROUTE_BURN_LIMIT,
        type: XERC20Type.Standard,
      },
    },
>>>>>>> main
  },
  ethereum: {
    type: TokenType.XERC20Lockbox,
    token: '0x0797c6f55f5c9005996A55959A341018cF69A963',
<<<<<<< HEAD
=======
    xERC20: {
      extraBridges: [
        {
          // Chainlink Pool
          lockbox: '0x04db9b1D7f52cB288b95B4934a1fA688F6d0cBc3',
          limits: {
            mint: EXTRA_BRIDGE_MINT_LIMIT,
            burn: EXTRA_BRIDGE_BURN_LIMIT,
            type: XERC20Type.Standard,
          },
        },
      ],
      warpRouteLimits: {
        mint: WARP_ROUTE_MINT_LIMIT,
        burn: WARP_ROUTE_BURN_LIMIT,
        type: XERC20Type.Standard,
      },
    },
>>>>>>> main
  },
  worldchain: {
    type: TokenType.XERC20,
    token: '0x30974f73A4ac9E606Ed80da928e454977ac486D2',
<<<<<<< HEAD
=======
    xERC20: {
      extraBridges: [
        {
          // Chainlink Pool
          lockbox: '0xF8AE5209DE22dbd06Dace938934b0D75B5E80299',
          limits: {
            mint: EXTRA_BRIDGE_MINT_LIMIT,
            burn: EXTRA_BRIDGE_BURN_LIMIT,
            type: XERC20Type.Standard,
          },
        },
      ],
      warpRouteLimits: {
        mint: WARP_ROUTE_MINT_LIMIT,
        burn: WARP_ROUTE_BURN_LIMIT,
        type: XERC20Type.Standard,
      },
    },
>>>>>>> main
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
<<<<<<< HEAD
        collateralToken: chain === 'base' ? DEPLOYER : ownerMap[chain],
      },
      token: tokenMetadata[chain].token,
=======
        collateralToken: ownerMap[chain],
      },
      token: tokenMetadata[chain].token,
      xERC20: tokenMetadata[chain].xERC20,
>>>>>>> main
    };
  }

  return configs;
};

export const getoXAUTGnosisSafeSubmitterStrategyConfig =
  getGnosisSafeSubmitterStrategyConfigGenerator(ownerMap);
