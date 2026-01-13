import { AleoTransaction } from '../utils/types.js';

export function getCreateTestIsmTx(
  ismManagerProgramId: string,
): AleoTransaction {
  return {
    programName: ismManagerProgramId,
    functionName: 'init_noop',
    priorityFee: 0,
    privateFee: false,
    inputs: [],
  };
}
