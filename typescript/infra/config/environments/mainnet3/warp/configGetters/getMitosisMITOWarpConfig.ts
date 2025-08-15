import {
  ChainMap,
  HookType,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

// 0x8f51e8e0Ce90CC1B6E60a3E434c7E63DeaD13612
const mitosisOwner = DEPLOYER;

export const getMitosisMITOWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const mitosis: HypTokenRouterConfig = {
    ...routerConfig.mitosis,
    owner: mitosisOwner,
    type: TokenType.native,
    hook: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MAILBOX_DEFAULT,
        },
        {
          type: HookType.PAUSABLE,
          owner: mitosisOwner,
          paused: false,
        },
      ],
    },
    interchainSecurityModule: {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        {
          type: IsmType.FALLBACK_ROUTING,
          owner: mitosisOwner,
          domains: {},
        },
        {
          type: IsmType.PAUSABLE,
          owner: mitosisOwner,
          paused: false,
        },
      ],
    },
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: mitosisOwner,
    type: TokenType.synthetic,
    symbol: 'MITO',
    hook: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MAILBOX_DEFAULT,
        },
        {
          type: HookType.PAUSABLE,
          owner: mitosisOwner,
          paused: false,
        },
      ],
    },
    interchainSecurityModule: {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        {
          type: IsmType.FALLBACK_ROUTING,
          owner: mitosisOwner,
          domains: buildAggregationIsmConfigs(
            'bsc',
            ['mitosis'],
            defaultMultisigConfigs,
          ),
        },
        {
          type: IsmType.PAUSABLE,
          owner: mitosisOwner,
          paused: false,
        },
      ],
    },
  };

  return {
    mitosis,
    bsc,
  };
};
