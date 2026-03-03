import type { Address, Instruction } from '@solana/kit';

export interface SvmInstructionEnvelope {
  programAddress: Address;
  instruction: Instruction;
  label?: string;
}
