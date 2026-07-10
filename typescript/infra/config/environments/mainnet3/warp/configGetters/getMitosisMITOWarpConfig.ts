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

// Mitosis (customer) EOA. Still owns the ISMs; the proxyAdmins on both chains
// were handed off to the customer governance timelocks on 2025-09-23, so
// proxyAdmin ownership is expected to be the per-chain timelock, not this EOA.
const mitosisOwner = '0x8f51e8e0Ce90CC1B6E60a3E434c7E63DeaD13612';
const mitosisTimelockOwner = '0x1248163200964459971c7cC9631909132AD28C27';
const bscTimelockOwner = '0x1248163214D9A0D6F02932A245370D3fD9613A82';

export const getMitosisMITOWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const mitosis: HypTokenRouterConfig = {
    ...routerConfig.mitosis,
    owner: mitosisTimelockOwner,
    type: TokenType.native,
    ownerOverrides: {
      proxyAdmin: mitosisTimelockOwner,
    },
    hook: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MAILBOX_DEFAULT,
        },
        {
          type: HookType.PAUSABLE,
          owner: mitosisTimelockOwner,
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
    owner: bscTimelockOwner,
    ownerOverrides: {
      proxyAdmin: bscTimelockOwner,
    },
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
          owner: bscTimelockOwner,
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
