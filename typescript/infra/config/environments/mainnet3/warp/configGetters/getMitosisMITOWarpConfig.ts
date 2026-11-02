import {
  AggregationIsmConfig,
  ChainMap,
  HookType,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// Mitosis (customer) EOA. Still owns the ISMs; the proxyAdmins on both chains
// were handed off to the customer governance timelocks on 2025-09-23, so
// proxyAdmin ownership is expected to be the per-chain timelock, not this EOA.
const mitosisOwner = '0x8f51e8e0Ce90CC1B6E60a3E434c7E63DeaD13612';
const mitosisTimelockOwner = '0x1248163200964459971c7cC9631909132AD28C27';
const bscTimelockOwner = '0x1248163214D9A0D6F02932A245370D3fD9613A82';

const mitosisBscValidators = [
  '0x340058f071e8376c2ecff219e1e6620deea8a3c7',
  '0x3b3eb808d90a4e19bb601790a6b6297812d6a61f',
  '0x401f25ff73769ed85bdb449a4347a4fd2678acfe',
  '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36',
  '0x5450447aee7b544c462c9352bef7cad049b0c2dc',
];

// Customer on-chain fallback ISM omits the AW validator from the default set.
const mitosisBscIsmConfig: AggregationIsmConfig = {
  type: IsmType.AGGREGATION,
  threshold: 1,
  modules: [
    {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      threshold: 3,
      validators: mitosisBscValidators,
    },
    {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold: 3,
      validators: mitosisBscValidators,
    },
  ],
};

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
          domains: {
            mitosis: mitosisBscIsmConfig,
          },
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
