import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import {
  queryMappingValue,
  tryQueryMappingValue,
} from '../utils/base-query.js';
import { fromAleoAddress } from '../utils/helper.js';
import { AleoHookType } from '../utils/types.js';

/**
 * Type guard to check if a number is a valid AleoHookType
 */
function isAleoHookType(maybeHookType: number): maybeHookType is AleoHookType {
  switch (maybeHookType) {
    case AleoHookType.CUSTOM:
    case AleoHookType.MERKLE_TREE:
    case AleoHookType.INTERCHAIN_GAS_PAYMASTER:
    case AleoHookType.PAUSABLE:
      return true;
  }

  return false;
}

/**
 * Query the hook type for a given hook address.
 *
 * @param aleoClient - The Aleo network client
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @returns The hook type
 */
export async function getHookType(
  aleoClient: AnyAleoNetworkClient,
  hookAddress: string,
): Promise<AltVM.HookType> {
  const { address, programId } = fromAleoAddress(hookAddress);

  const result = await queryMappingValue(
    aleoClient,
    programId,
    'hooks',
    address,
    (raw) => {
      assert(
        typeof raw === 'number',
        `Expected hook type to be a number but got ${typeof raw}`,
      );

      return raw;
    },
  );

  assert(
    isAleoHookType(result),
    `Unknown hook type ${result} for address: ${hookAddress}`,
  );

  switch (result) {
    case AleoHookType.CUSTOM:
      return AltVM.HookType.CUSTOM;
    case AleoHookType.MERKLE_TREE:
      return AltVM.HookType.MERKLE_TREE;
    case AleoHookType.INTERCHAIN_GAS_PAYMASTER:
      return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
    case AleoHookType.PAUSABLE:
      return AltVM.HookType.PAUSABLE;
    default:
      throw new Error(
        `Unknown hook type ${result} for address: ${hookAddress}`,
      );
  }
}

/**
 * Query the configuration for a MerkleTree hook.
 *
 * @param aleoClient - The Aleo network client
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @returns The MerkleTree hook configuration
 */
export async function getMerkleTreeHookConfig(
  aleoClient: AnyAleoNetworkClient,
  hookAddress: string,
): Promise<{
  type: AleoHookType.MERKLE_TREE;
  address: string;
}> {
  const hookType = await getHookType(aleoClient, hookAddress);

  assert(
    hookType === AltVM.HookType.MERKLE_TREE,
    `Expected MerkleTree hook but got ${hookType} at address ${hookAddress}`,
  );

  return {
    type: AleoHookType.MERKLE_TREE,
    address: hookAddress,
  };
}

/**
 * Query the configuration for an IGP (Interchain Gas Paymaster) hook.
 *
 * @param aleoClient - The Aleo network client
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @returns The IGP hook configuration with owner and destination gas configs
 */
export async function getIgpHookConfig(
  aleoClient: AnyAleoNetworkClient,
  hookAddress: string,
): Promise<{
  type: AleoHookType.INTERCHAIN_GAS_PAYMASTER;
  address: string;
  owner: string;
  destinationGasConfigs: {
    [domainId: string]: {
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  };
}> {
  const hookType = await getHookType(aleoClient, hookAddress);

  assert(
    hookType === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
    `Expected IGP hook but got ${hookType} at address ${hookAddress}`,
  );

  const { programId, address } = fromAleoAddress(hookAddress);

  const destinationGasConfigs: {
    [domainId: string]: {
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  } = {};

  const igpData = await queryMappingValue(
    aleoClient,
    programId,
    'igps',
    address,
    (raw) => raw as any,
  );
  const owner = igpData.hook_owner;

  const gasConfigLength = await tryQueryMappingValue(
    aleoClient,
    programId,
    'destination_gas_config_length',
    address,
    (raw) => raw as number,
  );

  for (let i = 0; i < (gasConfigLength || 0); i++) {
    const gasConfigKey = await aleoClient.getProgramMappingPlaintext(
      programId,
      'destination_gas_config_iter',
      `{hook:${address},index:${i}u32}`,
    );

    const destinationGasConfig = await tryQueryMappingValue(
      aleoClient,
      programId,
      'destination_gas_configs',
      gasConfigKey.toString(),
      (raw) => raw as any,
    );

    // This is necessary because `destination_gas_config_iter` maintains keys for all destination domain entries,
    // including those from domains that have already been removed. When a domain is
    // deleted from the Destination Gas Configs, its key remains in the map and `destination_gas_configs` simply returns null.
    if (!destinationGasConfig) continue;

    destinationGasConfigs[gasConfigKey.toObject().destination] = {
      gasOracle: {
        tokenExchangeRate: destinationGasConfig.exchange_rate.toString(),
        gasPrice: destinationGasConfig.gas_price.toString(),
      },
      gasOverhead: destinationGasConfig.gas_overhead.toString(),
    };
  }

  return {
    type: AleoHookType.INTERCHAIN_GAS_PAYMASTER,
    address: hookAddress,
    owner,
    destinationGasConfigs,
  };
}
