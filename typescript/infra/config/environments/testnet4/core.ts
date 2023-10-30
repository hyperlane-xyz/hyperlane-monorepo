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
  IsmType,
  MerkleTreeHookConfig,
  MultisigConfig,
  MultisigIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { OpStackIsmConfig } from '@hyperlane-xyz/sdk/dist/ism/types';
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
  if (local === Chains.basegoerli || local === Chains.optimismgoerli) {
    defaultIsm.domains[Chains.goerli] = {
      origin: Chains.goerli,
      type: IsmType.OP_STACK,
      nativeBridge: '0x4200000000000000000000000000000000000007',
    } as OpStackIsmConfig;
  }

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igp[local],
  };

  const aggregationHook = (opStackHook: HookConfig): AggregationHookConfig => ({
    type: HookType.AGGREGATION,
    hooks: [opStackHook, igpHook],
  });

  const domains = Object.fromEntries(
    Object.entries(owners)
      .filter(([chain, _]) => chain !== local)
      .map(([chain, _]) => [chain, aggregationHook(merkleHook) as HookConfig]),
  );

  // if (local === Chains.goerli) {
  //   domains[Chains.optimismgoerli] = aggregationHook(opHookConfig);
  //   domains[Chains.basegoerli] = aggregationHook(baseHookConfig);
  // }

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
