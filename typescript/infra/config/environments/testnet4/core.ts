import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  Chains,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookConfig,
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
import { baseHookConfig, opHookConfig } from './hooks';
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

  const aggregationHook: AggregationHookConfig = {
    type: HookType.AGGREGATION,
    hooks: [merkleHook, igpHook],
  };

  const domains = Object.fromEntries(
    Object.entries(owners)
      .filter(([chain, _]) => chain !== local)
      .map(([chain, _]) => [chain, aggregationHook as HookConfig]),
  );
  if (local === Chains.goerli) {
    domains[Chains.optimismgoerli] = opHookConfig;
    domains[Chains.basegoerli] = baseHookConfig;
  }

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    owner,
    fallback: merkleHook,
    domains: domains,
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
