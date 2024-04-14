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
  PausableHookConfig,
  PausableIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains.js';
import { igp } from './igp.js';
import { DEPLOYER, owners } from './owners.js';

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

  const routingIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    domains: objMap(
      originMultisigs,
      (_, multisig): AggregationIsmConfig => ({
        type: IsmType.AGGREGATION,
        modules: [messageIdIsm(multisig), merkleRoot(multisig)],
        threshold: 1,
      }),
    ),
    ...owner,
  };

  const pausableIsm: PausableIsmConfig = {
    type: IsmType.PAUSABLE,
    owner: DEPLOYER, // keep pausable hot
  };

  const defaultIsm: AggregationIsmConfig = {
    type: IsmType.AGGREGATION,
    modules: [routingIsm, pausableIsm],
    threshold: 2,
  };

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igp[local],
  };

  const pausableHook: PausableHookConfig = {
    type: HookType.PAUSABLE,
    owner: DEPLOYER, // keep pausable hot
  };
  const aggregationHooks = objMap(
    originMultisigs,
    (_origin, _): AggregationHookConfig => ({
      type: HookType.AGGREGATION,
      hooks: [pausableHook, merkleHook, igpHook],
    }),
  );
  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    ...owner,
    domains: aggregationHooks,
    fallback: merkleHook,
  };

  if (typeof owner.owner !== 'string') {
    throw new Error('beneficiary must be a string');
  }
  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
    protocolFee: BigNumber.from(0).toString(), // 0 wei
    beneficiary: owner.owner as Address, // Owner can be AccountConfig
    ...owner,
  };

  return {
    defaultIsm,
    defaultHook,
    requiredHook,
    ...owner,
  };
});
