import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookType,
  IgpHookConfig,
  IsmType,
  MerkleTreeHookConfig,
  MultisigConfig,
  MultisigIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';
import { igp } from './igp';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
    supportedChainNames
      .filter((chain) => chain !== local)
      .map((origin) => [origin, defaultMultisigConfigs[origin]]),
  );

  const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig => ({
    type: IsmType.MERKLE_ROOT_MULTISIG,
    ...multisig,
  });

  const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig => ({
    type: IsmType.MESSAGE_ID_MULTISIG,
    ...multisig,
  });

  const defaultIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    domains: objMap(
      originMultisigs,
      (_, multisig): AggregationIsmConfig => ({
        type: IsmType.AGGREGATION,
        modules: [messageIdIsm(multisig), merkleRoot(multisig)],
        threshold: 1,
      }),
    ),
    owner,
  };

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igp[local],
  };

  const aggregationHooks = objMap(
    originMultisigs,
    (_origin, _): AggregationHookConfig => ({
      type: HookType.AGGREGATION,
      hooks: [igpHook, merkleHook],
    }),
  );

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    owner,
    fallback: merkleHook,
    domains: aggregationHooks,
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
