import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
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
