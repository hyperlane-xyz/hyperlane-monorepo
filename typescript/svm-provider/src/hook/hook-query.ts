import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
} from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';

import { type Igp, getIgpDecoder } from '../generated/accounts/igp.js';
import {
  type OverheadIgp,
  getOverheadIgpDecoder,
} from '../generated/accounts/overheadIgp.js';
import {
  type ProgramData,
  getProgramDataDecoder,
} from '../generated/accounts/programData.js';
import {
  getIgpAccountPda,
  getIgpProgramDataPda,
  getOverheadIgpAccountPda,
} from '../pda.js';

/**
 * IGP account discriminators (8 bytes each).
 * Used to verify account types and skip prefix during decoding.
 */
const IGP_DISCRIMINATORS = {
  PROGRAM_DATA: new Uint8Array([80, 82, 71, 77, 68, 65, 84, 65]), // "PRGMDATA"
  IGP: new Uint8Array([73, 71, 80, 95, 95, 95, 95, 95]), // "IGP_____"
  OVERHEAD_IGP: new Uint8Array([79, 86, 82, 72, 68, 73, 71, 80]), // "OVRHDIGP"
};

/**
 * Fetches raw account data and handles the AccountData<DiscriminatorPrefixed<T>> wrapper.
 *
 * Hyperlane Sealevel IGP accounts use AccountData<DiscriminatorPrefixed<T>> which prepends:
 * - 1 byte: initialized flag
 * - 8 bytes: discriminator (e.g., "IGP_____", "PRGMDATA", "OVRHDIGP")
 *
 * This function reads the account, checks the initialized flag and discriminator,
 * and returns the raw data bytes (without prefix) for decoding.
 */
async function fetchIgpAccountDataWithPrefix(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
  expectedDiscriminator: Uint8Array,
): Promise<Uint8Array | null> {
  const maybeAccount = await fetchEncodedAccount(rpc, address);
  if (!maybeAccount.exists) {
    return null;
  }

  const data = maybeAccount.data;
  // Minimum size: 1 byte init + 8 bytes discriminator
  if (data.length < 9) {
    return null;
  }

  // First byte is the initialized flag
  const initialized = data[0] !== 0;
  if (!initialized) {
    return null;
  }

  // Next 8 bytes are the discriminator
  const discriminator = data.slice(1, 9);
  const matches = expectedDiscriminator.every(
    (byte, i) => byte === discriminator[i],
  );
  if (!matches) {
    return null;
  }

  // Return data after the initialized flag and discriminator
  return data.slice(9);
}

/**
 * Fetches IGP program data (global state) from chain.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @returns ProgramData or null if not initialized
 */
export async function fetchIgpProgramData(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<ProgramData | null> {
  const [programDataPda] = await getIgpProgramDataPda(programId);
  const rawData = await fetchIgpAccountDataWithPrefix(
    rpc,
    programDataPda,
    IGP_DISCRIMINATORS.PROGRAM_DATA,
  );
  if (rawData === null) {
    return null;
  }
  const decoder = getProgramDataDecoder();
  return decoder.decode(rawData);
}

/**
 * Fetches an IGP account by salt.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @param salt - 32-byte salt (typically keccak256 of context string)
 * @returns Igp account data or null if not exists
 */
export async function fetchIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<Igp | null> {
  const [igpPda] = await getIgpAccountPda(programId, salt);
  const rawData = await fetchIgpAccountDataWithPrefix(
    rpc,
    igpPda,
    IGP_DISCRIMINATORS.IGP,
  );
  if (rawData === null) {
    return null;
  }
  const decoder = getIgpDecoder();
  return decoder.decode(rawData);
}

/**
 * Fetches an Overhead IGP account by salt.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @param salt - 32-byte salt (typically keccak256 of context string)
 * @returns OverheadIgp account data or null if not exists
 */
export async function fetchOverheadIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<OverheadIgp | null> {
  const [overheadIgpPda] = await getOverheadIgpAccountPda(programId, salt);
  const rawData = await fetchIgpAccountDataWithPrefix(
    rpc,
    overheadIgpPda,
    IGP_DISCRIMINATORS.OVERHEAD_IGP,
  );
  if (rawData === null) {
    return null;
  }
  const decoder = getOverheadIgpDecoder();
  return decoder.decode(rawData);
}

/**
 * Detects hook type.
 *
 * On Solana, hooks are program-based. The main types are:
 * - IGP (interchainGasPaymaster)
 * - MerkleTree (built into mailbox)
 *
 * @param rpc - Solana RPC client
 * @param address - Hook address (program ID or mailbox for merkle tree)
 * @returns Detected hook type
 */
export async function detectHookType(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<HookType> {
  // Check for IGP program data
  const igpProgramData = await fetchIgpProgramData(rpc, address);
  if (igpProgramData !== null) {
    return HookType.INTERCHAIN_GAS_PAYMASTER;
  }

  // On Solana, merkle tree is part of mailbox, so detection is done by
  // checking if it's a mailbox address. For now, if it's not IGP, assume merkle.
  // This is a simplification - proper detection would need mailbox program info.
  return HookType.MERKLE_TREE;
}

/**
 * Converts remote gas data from on-chain format to readable format.
 */
export function remoteGasDataToConfig(gasOracle: {
  __kind: 'RemoteGasData';
  fields: readonly [
    {
      tokenExchangeRate: bigint;
      gasPrice: bigint;
      tokenDecimals: number;
    },
  ];
}): {
  gasPrice: string;
  tokenExchangeRate: string;
  tokenDecimals: number;
} {
  const data = gasOracle.fields[0];
  return {
    gasPrice: data.gasPrice.toString(),
    tokenExchangeRate: data.tokenExchangeRate.toString(),
    tokenDecimals: data.tokenDecimals,
  };
}
