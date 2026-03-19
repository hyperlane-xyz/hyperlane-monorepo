import {
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getUtf8Encoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';

import type { PdaWithBump } from './types.js';

const utf8 = getUtf8Encoder();
const u32 = getU32Encoder();
const addressEncoder = getAddressEncoder();
// Intentionally using @solana/kit re-exports for consistency with package-wide imports.

async function derive(
  programAddress: Address,
  seeds: ReadonlyUint8Array[],
): Promise<PdaWithBump> {
  const pda = await getProgramDerivedAddress({ programAddress, seeds });
  return { pda, address: pda[0], bump: pda[1] };
}

export async function deriveMultisigIsmAccessControlPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('multisig_ism_message_id'),
    utf8.encode('-'),
    utf8.encode('access_control'),
  ]);
}

export async function deriveMultisigIsmDomainDataPda(
  programAddress: Address,
  domain: number,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('multisig_ism_message_id'),
    utf8.encode('-'),
    u32.encode(domain),
    utf8.encode('-'),
    utf8.encode('domain_data'),
  ]);
}

export async function deriveTestIsmStoragePda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('test_ism'),
    utf8.encode('-'),
    utf8.encode('storage'),
  ]);
}

export async function deriveHyperlaneTokenPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_message_recipient'),
    utf8.encode('-'),
    utf8.encode('handle'),
    utf8.encode('-'),
    utf8.encode('account_metas'),
  ]);
}

export async function deriveMailboxDispatchAuthorityPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_dispatcher'),
    utf8.encode('-'),
    utf8.encode('dispatch_authority'),
  ]);
}

export async function deriveMailboxProcessAuthorityPda(
  mailboxProgramAddress: Address,
  recipientProgramAddress: Address,
): Promise<PdaWithBump> {
  return derive(mailboxProgramAddress, [
    utf8.encode('hyperlane'),
    utf8.encode('-'),
    utf8.encode('process_authority'),
    utf8.encode('-'),
    addressEncoder.encode(recipientProgramAddress),
  ]);
}

export async function deriveIgpProgramDataPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('program_data'),
  ]);
}

export async function deriveIgpAccountPda(
  programAddress: Address,
  salt: Uint8Array,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('igp'),
    utf8.encode('-'),
    salt,
  ]);
}

export async function deriveOverheadIgpAccountPda(
  programAddress: Address,
  salt: Uint8Array,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('overhead_igp'),
    utf8.encode('-'),
    salt,
  ]);
}

export async function deriveValidatorAnnouncePda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_validator_announce'),
    utf8.encode('-'),
    utf8.encode('validator_announce'),
  ]);
}

export async function deriveNativeCollateralPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token'),
    utf8.encode('-'),
    utf8.encode('native_collateral'),
  ]);
}

export async function deriveSyntheticMintPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token'),
    utf8.encode('-'),
    utf8.encode('mint'),
  ]);
}

export async function deriveAtaPayerPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token'),
    utf8.encode('-'),
    utf8.encode('ata_payer'),
  ]);
}

export async function deriveEscrowPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token'),
    utf8.encode('-'),
    utf8.encode('escrow'),
  ]);
}
