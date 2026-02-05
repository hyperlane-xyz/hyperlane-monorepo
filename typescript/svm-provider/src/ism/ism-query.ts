import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';

import {
  type AccessControlData,
  fetchMaybeAccessControlData,
} from '../generated/accounts/accessControlData.js';
import {
  type DomainData,
  fetchMaybeDomainData,
} from '../generated/accounts/domainData.js';
import {
  type TestIsmStorage,
  fetchMaybeTestIsmStorage,
} from '../generated/accounts/testIsmStorage.js';
import {
  getMultisigIsmAccessControlPda,
  getMultisigIsmDomainDataPda,
  getTestIsmStoragePda,
} from '../pda.js';

/**
 * Fetches TestIsmStorage account data from chain.
 *
 * @param rpc - Solana RPC client
 * @param programId - Test ISM program ID
 * @returns TestIsmStorage data or null if not initialized
 */
export async function fetchTestIsmStorageAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<TestIsmStorage | null> {
  const [storagePda] = await getTestIsmStoragePda(programId);
  const account = await fetchMaybeTestIsmStorage(rpc, storagePda);
  return account.exists ? account.data : null;
}

/**
 * Fetches MultisigIsm AccessControlData account from chain.
 *
 * @param rpc - Solana RPC client
 * @param programId - Multisig ISM program ID
 * @returns AccessControlData or null if not initialized
 */
export async function fetchMultisigIsmAccessControl(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<AccessControlData | null> {
  const [accessControlPda] = await getMultisigIsmAccessControlPda(programId);
  const account = await fetchMaybeAccessControlData(rpc, accessControlPda);
  return account.exists ? account.data : null;
}

/**
 * Fetches MultisigIsm DomainData account for a specific domain.
 *
 * @param rpc - Solana RPC client
 * @param programId - Multisig ISM program ID
 * @param domain - Domain ID to fetch validators for
 * @returns DomainData or null if not configured for this domain
 */
export async function fetchMultisigIsmDomainData(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  domain: number,
): Promise<DomainData | null> {
  const [domainPda] = await getMultisigIsmDomainDataPda(programId, domain);
  const account = await fetchMaybeDomainData(rpc, domainPda);
  return account.exists ? account.data : null;
}

/**
 * Detects the ISM type by checking which account structures exist.
 *
 * On Solana, ISM "address" is actually a program ID. We detect type by
 * checking which PDA accounts exist for that program.
 *
 * @param rpc - Solana RPC client
 * @param programId - Program ID to check
 * @returns Detected ISM type
 */
export async function detectIsmType(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<IsmType> {
  // Check for Test ISM storage
  const testIsmStorage = await fetchTestIsmStorageAccount(rpc, programId);
  if (testIsmStorage !== null) {
    return IsmType.TEST_ISM;
  }

  // Check for Multisig ISM access control
  const accessControl = await fetchMultisigIsmAccessControl(rpc, programId);
  if (accessControl !== null) {
    // Solana only has message ID multisig ISM (no merkle root variant)
    return IsmType.MESSAGE_ID_MULTISIG;
  }

  throw new Error(`Unable to detect ISM type for program: ${programId}`);
}

/**
 * Converts validator bytes (20-byte Ethereum addresses) to hex strings.
 */
export function validatorBytesToHex(validators: Uint8Array[]): string[] {
  return validators.map((v) => '0x' + Buffer.from(v).toString('hex'));
}
