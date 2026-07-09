/**
 * Program version detection and comparison for Hyperlane SVM programs.
 *
 * All programs implementing the PackageVersioned trait respond to a
 * universal 8-byte discriminator with their version string via
 * set_return_data. This module queries and compares those versions.
 */
import {
  SOLANA_ERROR__INSTRUCTION_ERROR__BORSH_IO_ERROR,
  SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_INSTRUCTION_DATA,
  SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPLETE,
  getSolanaErrorFromTransactionError,
  isSolanaError,
} from '@solana/errors';
import {
  type Address,
  type Base64EncodedWireTransaction,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { compareVersions as compareSemver } from 'compare-versions';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { ByteCursor } from '../codecs/binary.js';
import { buildGetProgramVersionInstruction } from '../instructions/version.js';
import type { SvmRpc } from '../types.js';

const logger = rootLogger.child({ module: 'version-query' });

/** Minimum program version that supports SetFeeConfig and fee section. */
export const SVM_PROGRAM_MINIMUM_FEE_SUPPORT_VERSION = '1.0.0';

/**
 * Queries the on-chain version of a deployed Hyperlane SVM program.
 *
 * Uses transaction simulation (no on-chain state change) to call the
 * GetProgramVersion instruction and parse the return data.
 *
 * @returns The version string (e.g. "1.0.0") or null if the program
 *          does not support versioning (pre-PackageVersioned programs).
 * @throws On RPC/network failures — only returns null for programs that
 *         reject the instruction (InvalidInstructionData).
 */
export async function queryProgramVersion(
  rpc: SvmRpc,
  programAddress: Address,
  payer: Address,
): Promise<string | null> {
  const ix = buildGetProgramVersionInstruction(programAddress);

  // Build a minimal v0 message for simulation. The fee payer must be an
  // existing non-executable account (simulation validates existence even
  // with sigVerify=false) and must differ from the invoked program.
  const txMessage = createTransactionMessage({ version: 0 });
  const withPayer = setTransactionMessageFeePayer(payer, txMessage);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 0n,
    },
    withPayer,
  );
  const withIx = appendTransactionMessageInstructions([ix], withLifetime);
  const compiled = compileTransactionMessage(withIx);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);

  // Build full unsigned wire transaction (signature count + zero-filled
  // signature slots + compiled message). The RPC requires a full
  // VersionedTransaction even for simulation with sigVerify=false.
  const sigCountBytes = getShortU16Encoder().encode(
    compiled.header.numSignerAccounts,
  );
  const sigsLen = compiled.header.numSignerAccounts * 64;
  const wireBytes = new Uint8Array(
    sigCountBytes.length + sigsLen + messageBytes.length,
  );
  wireBytes.set(sigCountBytes, 0);
  wireBytes.set(messageBytes, sigCountBytes.length + sigsLen);

  // CAST: the branded type expects a signed wire transaction but we
  // built an unsigned one — sigVerify=false makes this valid.
  const base64Tx = Buffer.from(wireBytes).toString(
    'base64',
  ) as Base64EncodedWireTransaction;

  const { value: result } = await rpc
    .simulateTransaction(base64Tx, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [] },
    })
    .send();

  // A pre-PackageVersioned program rejects the GetProgramVersion discriminator
  // via Borsh decode failure, InvalidInstructionData, or panic. Any other error
  // (BlockhashNotFound, AccountNotFound, etc.) is an infra failure that would
  // otherwise be silently misclassified as a pre-versioned program.
  if (result.err) {
    const solanaError = getSolanaErrorFromTransactionError(result.err);
    if (
      isSolanaError(
        solanaError,
        SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_INSTRUCTION_DATA,
      ) ||
      isSolanaError(
        solanaError,
        SOLANA_ERROR__INSTRUCTION_ERROR__BORSH_IO_ERROR,
      ) ||
      isSolanaError(
        solanaError,
        SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPLETE,
      )
    ) {
      logger.debug('Pre-versioned program rejected GetProgramVersion', {
        programAddress,
        err: result.err,
      });
      return null;
    }
    throw solanaError;
  }

  const returnData = result.returnData;
  if (!returnData?.data?.[0]) return null;

  const raw = Buffer.from(returnData.data[0], 'base64');
  return decodeSimulationReturnDataString(raw);
}

/**
 * Decodes a SimulationReturnData<String> payload from Borsh.
 *
 * The Rust SimulationReturnData::new(version) serializes as:
 *   - Borsh String: u32le length prefix + UTF-8 bytes
 *   - trailing u8 tag set to u8::MAX (255), non-zero on purpose to avoid
 *     Solana's return-data zero-truncation bug (solana-labs/solana#31391)
 */
function decodeSimulationReturnDataString(raw: Uint8Array): string {
  assert(raw.length >= 5, 'SimulationReturnData<String> too short');
  const cursor = new ByteCursor(raw);
  const strLen = cursor.readU32LE();
  assert(
    raw.length === 4 + strLen + 1,
    `Malformed SimulationReturnData<String>: expected ${4 + strLen + 1} bytes, got ${raw.length}`,
  );
  return new TextDecoder().decode(cursor.readBytes(strLen));
}

/**
 * Compares two semver version strings.
 * Uses the `compare-versions` library (same as the EVM SDK).
 * @returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
  return compareSemver(a, b);
}

/**
 * Returns true if the given version supports fee configuration
 * (SetFeeConfig instruction, fee section in TransferRemote).
 */
export function supportsFeeConfig(version: string | null | undefined): boolean {
  if (!version) return false;
  return compareVersions(version, SVM_PROGRAM_MINIMUM_FEE_SUPPORT_VERSION) >= 0;
}
