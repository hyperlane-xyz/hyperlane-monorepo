// SPDX-License-Identifier: BUSL-1.1
import { BigNumber, ethers } from 'ethers';

import {
  AggregationIsmConfig,
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
import { Address, assert } from '@hyperlane-xyz/utils';

import { getOverheadWithOverrides } from '../../../src/config/gas-oracle.js';

import { DEPLOYER } from './owners.js';

export const TRON_CONNECTED_CHAINS = [
  'base',
  'arbitrum',
  'optimism',
  'ethereum',
  'ink',
  'bsc',
  'solanamainnet',
  'celo',
  'unichain',
  'polygon',
  'soneium',
  'lisk',
  'plasma',
  'citrea',
  'eclipsemainnet',
  'linea',
  'mode',
  'superseed',
  'hyperevm',
  'mantle',
  'blast',
];

export function getTronIgpConfig(
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
      TRON_CONNECTED_CHAINS.map((remote) => [
        remote,
        getOverheadWithOverrides('tron', remote),
      ]),
    ),
    oracleConfig: Object.fromEntries(
      TRON_CONNECTED_CHAINS.map((remote) => {
        const config = storageGasOracleConfig['tron'][remote];
        assert(config, `Missing gas oracle config for tron -> ${remote}`);
        return [remote, config];
      }),
    ),
  };
}

export function getTronCoreConfig(
  owner: OwnableConfig,
  igpConfig: IgpConfig,
): CoreConfig {
  const routingIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    domains: Object.fromEntries(
      TRON_CONNECTED_CHAINS.map((chain) => {
        const multisig = defaultMultisigConfigs[chain];
        const merkleRoot = multisigConfigToIsmConfig(
          IsmType.MERKLE_ROOT_MULTISIG,
          multisig,
        );
        const messageIdIsm = multisigConfigToIsmConfig(
          IsmType.MESSAGE_ID_MULTISIG,
          multisig,
        );
        return [
          chain,
          {
            type: IsmType.AGGREGATION,
            modules: [messageIdIsm, merkleRoot],
            threshold: 1,
          },
        ];
      }),
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
      TRON_CONNECTED_CHAINS.map((chain) => [
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
