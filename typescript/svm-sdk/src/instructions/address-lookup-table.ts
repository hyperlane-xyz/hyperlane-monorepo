import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  findAddressLookupTablePda,
  getCreateLookupTableInstructionDataEncoder,
  getExtendLookupTableInstructionDataEncoder,
  getFreezeLookupTableInstructionDataEncoder,
} from '@solana-program/address-lookup-table';
import type { Address, Instruction } from '@solana/kit';

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';

import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
  writableSignerAddress,
} from './utils.js';

/** Output of `getCreateAddressLookupTableInstruction`. Carries the derived ALT address + bump alongside the instruction. */
export interface BuiltAddressLookupTable {
  address: Address;
  bump: number;
  instruction: Instruction;
}

/**
 * Builds the instruction that creates a new address-lookup table.
 *
 * The ALT PDA is derived from `(authority, recentSlot)`. `recentSlot` must
 * be within roughly the last 150 slots of the submission slot; the on-chain
 * program rejects stale slots.
 *
 * Inputs are plain `Address`es — signer responsibility is expressed through
 * the returned instruction's account roles (the payer is marked as a
 * writable signer) so callers can pair the instruction with whatever
 * signing strategy they use.
 */
export async function getCreateAddressLookupTableInstruction(args: {
  authority: Address;
  payer: Address;
  recentSlot: bigint;
}): Promise<BuiltAddressLookupTable> {
  const [altAddress, bump] = await findAddressLookupTablePda({
    authority: args.authority,
    recentSlot: args.recentSlot,
  });
  const data = getCreateLookupTableInstructionDataEncoder().encode({
    recentSlot: args.recentSlot,
    bump,
  });
  return {
    address: altAddress,
    bump,
    instruction: buildInstruction(
      ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
      [
        writableAccount(altAddress),
        readonlyAccount(args.authority),
        writableSignerAddress(args.payer),
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      ],
      data,
    ),
  };
}

/** Builds the instruction that appends `addresses` to an existing ALT. */
export function getExtendAddressLookupTableInstruction(args: {
  address: Address;
  authority: Address;
  payer: Address;
  addresses: Address[];
}): Instruction {
  const data = getExtendLookupTableInstructionDataEncoder().encode({
    addresses: args.addresses,
  });
  return buildInstruction(
    ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
    [
      writableAccount(args.address),
      readonlySignerAddress(args.authority),
      writableSignerAddress(args.payer),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    data,
  );
}

/**
 * Builds the instruction that freezes an address-lookup table, making it
 * immutable for the rest of its lifetime. Once frozen the ALT cannot be
 * extended, deactivated, or closed — only read.
 *
 * Use this after fully populating an ALT meant to back long-lived warp-route
 * deployments so the routing accounts can't be tampered with later.
 */
export function getFreezeAddressLookupTableInstruction(args: {
  address: Address;
  authority: Address;
}): Instruction {
  const data = getFreezeLookupTableInstructionDataEncoder().encode({});
  return buildInstruction(
    ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
    [writableAccount(args.address), readonlySignerAddress(args.authority)],
    data,
  );
}
