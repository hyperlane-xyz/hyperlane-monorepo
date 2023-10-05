import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ModuleType,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolFeeHookConfig } from '@hyperlane-xyz/sdk/src/hook/types';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from './aggregationIsm';
import { igp } from './igp';
import { chainToValidator } from './multisigIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(chainToValidator)
        .filter(([chain, _]) => chain !== local)
        .map(([chain, validatorKey]) => [chain, aggregationIsm(validatorKey)]),
    ),
  };

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
