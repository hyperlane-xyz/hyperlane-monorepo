import { fromAleoAddress, getAddressFromProgramId } from '../utils/helper.js';
import { AleoTransaction } from '../utils/types.js';

/**
 * Build transaction to create a MerkleTree hook
 *
 * @param hookManagerProgramId - The hook manager program ID
 * @param dispatchProxyProgramId - The dispatch proxy program ID
 * @returns The transaction object
 */
export function getCreateMerkleTreeHookTx(
  hookManagerProgramId: string,
  dispatchProxyProgramId: string,
): AleoTransaction {
  return {
    programName: hookManagerProgramId,
    functionName: 'init_merkle_tree',
    priorityFee: 0,
    privateFee: false,
    inputs: [getAddressFromProgramId(dispatchProxyProgramId)],
  };
}

/**
 * Build transaction to create an IGP (InterchainGasPaymaster) hook
 *
 * @param hookManagerProgramId - The hook manager program ID
 * @returns The transaction object
 */
export function getCreateIgpHookTx(
  hookManagerProgramId: string,
): AleoTransaction {
  return {
    programName: hookManagerProgramId,
    functionName: 'init_igp',
    priorityFee: 0,
    privateFee: false,
    inputs: [],
  };
}

/**
 * Build transaction to set IGP hook owner
 *
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @param newOwner - The new owner address
 * @returns The transaction object
 */
export function getSetIgpHookOwnerTx(
  hookAddress: string,
  newOwner: string,
): AleoTransaction {
  const { programId, address } = fromAleoAddress(hookAddress);

  return {
    programName: programId,
    functionName: 'transfer_igp_ownership',
    priorityFee: 0,
    privateFee: false,
    inputs: [address, newOwner],
  };
}

/**
 * Build transaction to set destination gas configuration
 *
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @param gasConfig - The gas configuration for the destination
 * @returns The transaction object
 */
export function getSetDestinationGasConfigTx(
  hookAddress: string,
  gasConfig: {
    remoteDomainId: number;
    gasOverhead: string;
    tokenExchangeRate: string;
    gasPrice: string;
  },
): AleoTransaction {
  const { programId, address } = fromAleoAddress(hookAddress);

  return {
    programName: programId,
    functionName: 'set_destination_gas_config',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      address,
      `${gasConfig.remoteDomainId}u32`,
      `{gas_overhead:${gasConfig.gasOverhead}u128,exchange_rate:${gasConfig.tokenExchangeRate}u128,gas_price:${gasConfig.gasPrice}u128}`,
    ],
  };
}

/**
 * Build transaction to remove destination gas configuration
 *
 * @param hookAddress - The full hook address (e.g., "hook_manager.aleo/aleo1...")
 * @param remoteDomainId - The remote domain ID to remove
 * @returns The transaction object
 */
export function getRemoveDestinationGasConfigTx(
  hookAddress: string,
  remoteDomainId: number,
): AleoTransaction {
  const { programId, address } = fromAleoAddress(hookAddress);

  return {
    programName: programId,
    functionName: 'remove_destination_gas_config',
    priorityFee: 0,
    privateFee: false,
    inputs: [address, `${remoteDomainId}u32`],
  };
}
