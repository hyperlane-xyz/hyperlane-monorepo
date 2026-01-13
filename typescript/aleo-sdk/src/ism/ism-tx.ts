import { strip0x } from '@hyperlane-xyz/utils';

import { fillArray } from '../utils/helper.js';
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

export function getCreateMessageIdMultisigIsmTx(
  ismManagerProgramId: string,
  config: { validators: string[]; threshold: number },
): AleoTransaction {
  const MAXIMUM_VALIDATORS = 6;

  if (config.validators.length > MAXIMUM_VALIDATORS) {
    throw new Error(`maximum ${MAXIMUM_VALIDATORS} validators allowed`);
  }

  const validators = fillArray(
    config.validators.map((v) => ({
      bytes: [...Buffer.from(strip0x(v), 'hex')].map((b) => `${b}u8`),
    })),
    MAXIMUM_VALIDATORS,
    {
      bytes: Array(20).fill(`0u8`),
    },
  );

  return {
    programName: ismManagerProgramId,
    functionName: 'init_message_id_multisig',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      JSON.stringify(validators).replaceAll('"', ''),
      `${config.validators.length}u8`,
      `${config.threshold}u8`,
    ],
  };
}
