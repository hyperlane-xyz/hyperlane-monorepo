import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolFeeHookConfig } from '@hyperlane-xyz/sdk/src/hook/types';
import { objMap } from '@hyperlane-xyz/utils';

import { createIgpConfig } from '../igp';
import { routingOverAggregation } from '../ism';

import { testChainNames } from './chains';
import { storageGasOraclesConfig } from './gasOracle';
import { chainToValidator, multisigIsm } from './multisigIsm';
import { owners } from './owners';

const igpConfig = createIgpConfig(
  testChainNames,
  storageGasOraclesConfig,
  multisigIsm,
  owners,
);

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = routingOverAggregation(local, owners, [
    chainToValidator[local],
  ]);

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igpConfig[local],
  };

  const aggregationHook: AggregationHookConfig = {
    type: HookType.AGGREGATION,
    hooks: [merkleHook, igpHook],
  };

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    owner,
    fallback: merkleHook,
    domains: Object.fromEntries(
      Object.entries(chainToValidator)
        .filter(([chain, _]) => chain !== local)
        .map(([chain, _]) => [chain, aggregationHook]),
    ),
  };

  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
    protocolFee: BigNumber.from(1).toString(), // 1 wei
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
