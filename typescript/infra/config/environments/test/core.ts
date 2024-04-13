import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookType,
  IgpHookConfig,
  IsmType,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from './aggregationIsm.js';
import { igp } from './igp.js';
import { chainToValidator } from './multisigIsm.js';
import { owners } from './owners.js';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    ...owner,
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

  const aggregationHook: AggregationHookConfig = {
    type: HookType.AGGREGATION,
    hooks: [merkleHook, igpHook],
  };

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    ...owner,
    fallback: merkleHook,
    domains: Object.fromEntries(
      Object.entries(chainToValidator)
        .filter(([chain, _]) => chain !== local)
        .map(([chain, _]) => [chain, aggregationHook]),
    ),
  };

  if (typeof owner.owner !== 'string') {
    throw new Error('Beneficiary must be an address');
  }
  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
    protocolFee: BigNumber.from(1).toString(), // 1 wei
    beneficiary: owner.owner,
    ...owner,
  };

  return {
    defaultIsm,
    defaultHook,
    requiredHook,
    ...owner,
  };
});
