import { getAddressFromProgramId } from '../utils/helper.js';
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
