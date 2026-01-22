import { BigNumber, ethers } from 'ethers';

import {
  AggregationIsmConfig,
  ChainName,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookType,
  IgpConfig,
  IsmType,
  MerkleTreeHookConfig,
  OwnableConfig,
  PausableHookConfig,
  PausableIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
  multisigConfigToIsmConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getOverhead } from '../../../src/config/gas-oracle.js';

import { DEPLOYER } from './owners.js';

export const EDEN_CONNECTED_CHAINS: ChainName[] = ['celestia'];

export function getEdenIgpConfig(
  owner: OwnableConfig,
  storageGasOracleConfig: Record<string, any>,
): IgpConfig {
  return {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...owner,
    ownerOverrides: {
      ...owner.ownerOverrides,
      interchainGasPaymaster: DEPLOYER,
      storageGasOracle: DEPLOYER,
    },
    oracleKey: DEPLOYER,
    beneficiary: DEPLOYER,
    overhead: Object.fromEntries(
      EDEN_CONNECTED_CHAINS.map((remote) => [
        remote,
        getOverhead('eden', remote),
      ]),
    ),
    oracleConfig: Object.fromEntries(
      EDEN_CONNECTED_CHAINS.map((remote) => [
        remote,
        storageGasOracleConfig['eden'][remote],
      ]),
    ),
  };
}

export function getEdenCoreConfig(
  owner: OwnableConfig,
  igpConfig: IgpConfig,
): CoreConfig {
  const celestiaMultisig = defaultMultisigConfigs['celestia'];

  const merkleRoot = multisigConfigToIsmConfig(
    IsmType.MERKLE_ROOT_MULTISIG,
    celestiaMultisig,
  );
  const messageIdIsm = multisigConfigToIsmConfig(
    IsmType.MESSAGE_ID_MULTISIG,
    celestiaMultisig,
  );

  const routingIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    domains: Object.fromEntries(
      EDEN_CONNECTED_CHAINS.map((chain) => [
        chain,
        {
          type: IsmType.AGGREGATION,
          modules: [messageIdIsm, merkleRoot],
          threshold: 1,
        } as AggregationIsmConfig,
      ]),
    ),
    ...owner,
  };

  const pausableIsm: PausableIsmConfig = {
    type: IsmType.PAUSABLE,
    paused: false,
    owner: DEPLOYER,
  };

  const defaultIsm: AggregationIsmConfig = {
    type: IsmType.AGGREGATION,
    modules: [routingIsm, pausableIsm],
    threshold: 2,
  };

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const pausableHook: PausableHookConfig = {
    type: HookType.PAUSABLE,
    paused: false,
    owner: DEPLOYER,
  };

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    ...owner,
    domains: Object.fromEntries(
      EDEN_CONNECTED_CHAINS.map((chain) => [
        chain,
        {
          type: HookType.AGGREGATION,
          hooks: [pausableHook, merkleHook, igpConfig],
        },
      ]),
    ),
    fallback: merkleHook,
  };

  if (typeof owner.owner !== 'string') {
    throw new Error('beneficiary must be a string');
  }

  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(),
    protocolFee: BigNumber.from(0).toString(),
    beneficiary: owner.owner as Address,
    ...owner,
  };

  return {
    defaultIsm,
    defaultHook,
    requiredHook,
    ...owner,
  };
}
