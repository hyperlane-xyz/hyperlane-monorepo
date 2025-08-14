import { keccak256 } from 'ethers/lib/utils.js';

export const EMPTY_BYTES_32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

export const PROPOSER_ROLE: string = keccak256(Buffer.from('PROPOSER_ROLE'));
export const EXECUTOR_ROLE: string = keccak256(Buffer.from('EXECUTOR_ROLE'));
export const CANCELLER_ROLE: string = keccak256(Buffer.from('CANCELLER_ROLE'));
