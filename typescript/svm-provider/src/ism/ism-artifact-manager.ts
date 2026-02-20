import type { Address } from '@solana/kit';

import { decodeIsmInstruction } from './ism-query.js';

export type IsmInstructionFamily = keyof typeof decodeIsmInstruction;

export function detectIsmInstructionFamily(
  data: Uint8Array,
): IsmInstructionFamily | null {
  if (decodeIsmInstruction.interchainSecurityModule(data)) {
    return 'interchainSecurityModule';
  }
  if (decodeIsmInstruction.multisigInterface(data)) {
    return 'multisigInterface';
  }
  if (decodeIsmInstruction.multisigProgram(data)) {
    return 'multisigProgram';
  }
  return null;
}

export interface IsmProgramSelector {
  testIsmProgramAddress: Address;
  multisigIsmProgramAddress: Address;
}
