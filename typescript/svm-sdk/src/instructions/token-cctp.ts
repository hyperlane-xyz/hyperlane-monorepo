import type { Address, Instruction, ReadonlyUint8Array } from '@solana/kit';

import { concatBytes, u32le, u64le } from '../codecs/binary.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';

import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
  writableSignerAddress,
} from './utils.js';

/**
 * 8-byte discriminator for the CCTP token program's bespoke
 * `SetRemoteConfig` instruction.
 * First 8 bytes of `sha256(b"hyperlane-token-cctp:set-remote-config")`.
 * Matches `SET_REMOTE_CONFIG_DISCRIMINATOR` in
 * rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/instruction.rs.
 */
export const CCTP_SET_REMOTE_CONFIG_DISCRIMINATOR = new Uint8Array([
  0x94, 0x96, 0x95, 0x24, 0xfe, 0x6a, 0x7b, 0x2f,
]);

export interface CctpSetRemoteConfigParams {
  destinationDomain: number;
  circleDomain: number;
  maxFee: bigint;
  minFinalityThreshold: number;
}

function encodeCctpSetRemoteConfig(
  params: CctpSetRemoteConfigParams,
): ReadonlyUint8Array {
  return concatBytes(
    CCTP_SET_REMOTE_CONFIG_DISCRIMINATOR,
    u32le(params.destinationDomain),
    u32le(params.circleDomain),
    u64le(params.maxFee),
    u32le(params.minFinalityThreshold),
  );
}

/**
 * Builds the CCTP token program's `SetRemoteConfig` instruction — creates or
 * updates the per-Hyperlane-destination-domain CCTP send config PDA. Matches
 * `set_remote_config`'s account order in
 * rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/processor.rs:
 * `[system_program, token_config_pda, owner(signer), payer(signer,
 * writable), remote_config_pda(writable)]`.
 */
export function getCctpSetRemoteConfigInstruction(
  programAddress: Address,
  tokenConfigPda: Address,
  owner: Address,
  payer: Address,
  remoteConfigPda: Address,
  params: CctpSetRemoteConfigParams,
): Instruction {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(tokenConfigPda),
      readonlySignerAddress(owner),
      writableSignerAddress(payer),
      writableAccount(remoteConfigPda),
    ],
    encodeCctpSetRemoteConfig(params),
  );
}
