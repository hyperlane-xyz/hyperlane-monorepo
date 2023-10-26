import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../contexts';
import { routingIsm } from '../../routingIsm';

import { igp } from './igp';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = routingIsm('mainnet2', local, Contexts.Hyperlane);

  let upgrade: CoreConfig['upgrade'];
  if (local === 'arbitrum') {
    upgrade = {
      timelock: {
        // 7 days in seconds
        delay: 7 * 24 * 60 * 60,
        roles: {
          proposer: owner,
          executor: owner,
        },
      },
    };
  }

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igp[local],
  };

  const defaultHook: AggregationHookConfig = {
    type: HookType.AGGREGATION,
    hooks: [merkleHook, igpHook],
  };

  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei'), // 1 gwei of native token
    protocolFee: BigNumber.from(1), // 1 wei
    beneficiary: owner,
    owner,
  };

  return {
    owner,
    defaultIsm,
    defaultHook,
    requiredHook,
  };
});
