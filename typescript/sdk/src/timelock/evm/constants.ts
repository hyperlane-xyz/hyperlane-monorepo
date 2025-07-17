import { keccak256 } from 'ethers/lib/utils.js';

export const PROPOSER_ROLE: string = keccak256(Buffer.from('PROPOSER_ROLE'));
export const EXECUTOR_ROLE: string = keccak256(Buffer.from('EXECUTOR_ROLE'));
export const CANCELLER_ROLE: string = keccak256(Buffer.from('CANCELLER_ROLE'));
