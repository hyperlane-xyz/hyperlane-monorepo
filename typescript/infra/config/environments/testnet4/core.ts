import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ModuleType,
  MultisigConfig,
  MultisigIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';
import { igp } from './igp';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
    supportedChainNames
      .filter((chain) => chain !== local)
      .map((origin) => [origin, defaultMultisigIsmConfigs[origin]]),
  );

  const messageIdRouting: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    domains: objMap(
      originMultisigs,
      (_, multisig): MultisigIsmConfig => ({
        type: ModuleType.MESSAGE_ID_MULTISIG,
        ...multisig,
      }),
    ),
    owner,
  };

  const merkleRootRouting: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    domains: objMap(
      originMultisigs,
      (_, multisig): MultisigIsmConfig => ({
        type: ModuleType.MERKLE_ROOT_MULTISIG,
        ...multisig,
      }),
    ),
    owner,
  };

  const defaultIsm: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [messageIdRouting, merkleRootRouting],
    threshold: 1,
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
