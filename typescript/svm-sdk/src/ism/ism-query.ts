import { type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';

import {
  type CompositeIsmStorage,
  decodeCompositeIsmStorageAccount,
} from '../accounts/composite-ism.js';
import {
  type AccessControlData,
  type DomainData,
  decodeMultisigIsmAccessControlAccount,
  decodeMultisigIsmDomainDataAccount,
} from '../accounts/multisig-ism-message-id.js';
import {
  decodeTestIsmStorageAccount,
  type TestIsmStorage,
} from '../accounts/test-ism.js';
import {
  decodeInterchainSecurityModuleInterfaceInstruction,
  decodeMultisigIsmInterfaceInstruction,
} from '../instructions/interfaces.js';
import { decodeMultisigIsmMessageIdProgramInstruction } from '../instructions/multisig-ism-message-id.js';
import {
  deriveCompositeIsmStoragePda,
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
  deriveTestIsmStoragePda,
} from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';

export const decodeIsmInstruction = {
  interchainSecurityModule: decodeInterchainSecurityModuleInterfaceInstruction,
  multisigInterface: decodeMultisigIsmInterfaceInstruction,
  multisigProgram: decodeMultisigIsmMessageIdProgramInstruction,
};

export const decodeIsmAccount = {
  multisigAccessControl: decodeMultisigIsmAccessControlAccount,
  multisigDomainData: decodeMultisigIsmDomainDataAccount,
  testIsmStorage: decodeTestIsmStorageAccount,
};

export async function fetchTestIsmStorageAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<TestIsmStorage | null> {
  const { address: storagePda } = await deriveTestIsmStoragePda(programId);
  const raw = await fetchAccountDataRaw(rpc, storagePda);
  if (!raw || raw.length === 0) return null;
  return decodeTestIsmStorageAccount(raw);
}

export async function fetchMultisigIsmAccessControl(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<AccessControlData | null> {
  const { address: accessControlPda } =
    await deriveMultisigIsmAccessControlPda(programId);
  const raw = await fetchAccountDataRaw(rpc, accessControlPda);
  if (!raw || raw.length === 0) return null;
  return decodeMultisigIsmAccessControlAccount(raw);
}

export async function fetchCompositeIsmStorageAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<CompositeIsmStorage | null> {
  const { address: storagePda } = await deriveCompositeIsmStoragePda(programId);
  const raw = await fetchAccountDataRaw(rpc, storagePda);
  if (!raw || raw.length === 0) return null;
  try {
    return decodeCompositeIsmStorageAccount(raw);
  } catch {
    // This probe runs concurrently with the test/multisig probes in
    // detectIsmType's Promise.all — a throw here (e.g. an unrelated account
    // happening to exist at this program's shared VAM PDA, or a future
    // incompatible storage format) must not reject the whole detection call
    // and take those other probes down with it. Treat a decode failure the
    // same as "no composite storage present", matching fetchDomainIsms'
    // handling of the same class of error.
    return null;
  }
}

export async function fetchMultisigIsmDomainData(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  domain: number,
): Promise<DomainData | null> {
  const { address: domainPda } = await deriveMultisigIsmDomainDataPda(
    programId,
    domain,
  );
  const raw = await fetchAccountDataRaw(rpc, domainPda);
  if (!raw || raw.length === 0) return null;
  return decodeMultisigIsmDomainDataAccount(raw);
}

export async function detectIsmType(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<IsmType> {
  // The three probes hit distinct, independently-derived PDAs, so they're
  // fetched concurrently — only the *interpretation* order below is
  // priority-sensitive (see the composite-ISM comment), not the fetch order.
  const [testIsmStorage, accessControl, composite] = await Promise.all([
    fetchTestIsmStorageAccount(rpc, programId),
    fetchMultisigIsmAccessControl(rpc, programId),
    fetchCompositeIsmStorageAccount(rpc, programId),
  ]);

  if (testIsmStorage !== null) {
    return IsmType.TEST_ISM;
  }

  if (accessControl !== null) {
    return IsmType.MESSAGE_ID_MULTISIG;
  }

  // Checked last: composite ISM's storage PDA uses the shared VAM seed
  // convention (unlike the two program-specific seeds probed above), and its
  // storage is the largest/most specific shape — checking it last minimizes
  // any chance of a false-positive decode against a differently-shaped
  // account that happens to exist at this program's VAM PDA.
  if (composite !== null && composite.root !== null) {
    return IsmType.COMPOSITE;
  }

  throw new Error(`Unable to detect ISM type for program: ${programId}`);
}

export function validatorBytesToHex(validators: Uint8Array[]): string[] {
  return validators.map((v) => '0x' + Buffer.from(v).toString('hex'));
}
