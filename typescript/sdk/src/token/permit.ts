import type { Address, Numberish } from '@hyperlane-xyz/utils';

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface PermitMessage {
  owner: Address;
  spender: Address;
  value: string;
  nonce: bigint;
  deadline: number;
}

export interface PermitData {
  domain: PermitDomain;
  message: PermitMessage;
  types: typeof PERMIT_TYPES;
}

export interface PermitSignature {
  v: number;
  r: string;
  s: string;
  deadline: number;
}

export interface GetPermitDataParams {
  owner: Address;
  spender: Address;
  amount: Numberish;
  deadline: number;
}

export interface PopulatePermitTxParams {
  owner: Address;
  spender: Address;
  amount: Numberish;
  deadline: number;
  signature: PermitSignature;
}
