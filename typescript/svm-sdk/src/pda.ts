import {
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getUtf8Encoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  CCTP_MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
  CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
  LOADER_V3_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
} from './constants.js';
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

/**
 * Composite ISM's storage PDA uses the shared VAM (VerifyAccountMetas) seed
 * convention (`VERIFY_ACCOUNT_METAS_PDA_SEEDS` in
 * hyperlane_sealevel_interchain_security_module_interface) rather than a
 * program-specific seed — this is what lets the relayer discover any Sealevel
 * ISM's account-metas PDA generically. No collision risk with
 * `deriveTestIsmStoragePda`/`deriveMultisigIsmAccessControlPda` above since
 * each uses its own distinct seed string relative to the same program ID.
 */
export async function deriveCompositeIsmStoragePda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_ism'),
    utf8.encode('-'),
    utf8.encode('verify'),
    utf8.encode('-'),
    utf8.encode('account_metas'),
  ]);
}

/** Per-domain override PDA for a composite ISM's `Routing`/`FallbackRouting` node. */
export async function deriveCompositeIsmDomainPda(
  programAddress: Address,
  domain: number,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('domain_ism'),
    u32.encode(domain),
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

export async function deriveIgpQuoteAuthorityPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_dispatcher'),
    utf8.encode('-'),
    utf8.encode('igp_quote_authority'),
  ]);
}

export async function deriveMailboxInboxPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane'),
    utf8.encode('-'),
    utf8.encode('inbox'),
  ]);
}

export async function deriveMailboxOutboxPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane'),
    utf8.encode('-'),
    utf8.encode('outbox'),
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

export async function deriveMailboxDispatchedMessagePda(
  mailboxProgramAddress: Address,
  uniqueMessageAccount: Address,
): Promise<PdaWithBump> {
  return derive(mailboxProgramAddress, [
    utf8.encode('hyperlane'),
    utf8.encode('-'),
    utf8.encode('dispatched_message'),
    utf8.encode('-'),
    addressEncoder.encode(uniqueMessageAccount),
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

export async function deriveIgpGasPaymentPda(
  igpProgramAddress: Address,
  uniqueMessageAccount: Address,
): Promise<PdaWithBump> {
  return derive(igpProgramAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('gas_payment'),
    utf8.encode('-'),
    addressEncoder.encode(uniqueMessageAccount),
  ]);
}

export async function deriveFeeTransientQuotePda(
  feeProgramAddress: Address,
  feeAccount: Address,
  scopedSalt: Uint8Array,
): Promise<PdaWithBump> {
  assert(
    scopedSalt.length === 32,
    `scopedSalt must be 32 bytes, got ${scopedSalt.length}`,
  );
  return derive(feeProgramAddress, [
    utf8.encode('hyperlane_fee'),
    utf8.encode('-'),
    utf8.encode('transient'),
    utf8.encode('-'),
    addressEncoder.encode(feeAccount),
    utf8.encode('-'),
    scopedSalt,
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

/** Derives the IGP standing-quote PDA for a (igp, mint, domain, sender) tuple. */
export async function deriveIgpStandingQuotePda(
  programAddress: Address,
  igpAccount: Address,
  feeTokenMint: Address,
  destinationDomain: number,
  sender: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('standing_quote'),
    utf8.encode('-'),
    addressEncoder.encode(igpAccount),
    utf8.encode('-'),
    addressEncoder.encode(feeTokenMint),
    utf8.encode('-'),
    u32.encode(destinationDomain),
    utf8.encode('-'),
    addressEncoder.encode(sender),
  ]);
}

/** Derives the IGP transient-quote PDA for a (igp, scoped_salt) tuple. */
export async function deriveIgpTransientQuotePda(
  programAddress: Address,
  igpAccount: Address,
  scopedSalt: Uint8Array,
): Promise<PdaWithBump> {
  assert(
    scopedSalt.length === 32,
    `scopedSalt must be 32 bytes, got ${scopedSalt.length}`,
  );
  return derive(programAddress, [
    utf8.encode('hyperlane_igp'),
    utf8.encode('-'),
    utf8.encode('transient_quote'),
    utf8.encode('-'),
    addressEncoder.encode(igpAccount),
    utf8.encode('-'),
    scopedSalt,
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

export async function deriveValidatorStorageLocationsPda(
  programAddress: Address,
  validatorH160: Uint8Array,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_validator_announce'),
    utf8.encode('-'),
    utf8.encode('storage_locations'),
    utf8.encode('-'),
    validatorH160,
  ]);
}

export async function deriveReplayProtectionPda(
  programAddress: Address,
  replayIdBytes: Uint8Array,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_validator_announce'),
    utf8.encode('-'),
    utf8.encode('replay_protection'),
    utf8.encode('-'),
    replayIdBytes,
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

/**
 * Derives the SPL Associated Token Account address for a (wallet, mint)
 * pair. `tokenProgram` defaults to the classic SPL Token program — pass
 * Token-2022 explicitly for Token-2022 mints.
 */
export async function deriveAssociatedTokenAddress(args: {
  wallet: Address;
  mint: Address;
  tokenProgram?: Address;
}): Promise<PdaWithBump> {
  const tokenProgram = args.tokenProgram ?? SPL_TOKEN_PROGRAM_ADDRESS;
  return derive(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, [
    addressEncoder.encode(args.wallet),
    addressEncoder.encode(tokenProgram),
    addressEncoder.encode(args.mint),
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

/**
 * Per-Hyperlane-destination-domain CCTP send config PDA. Matches
 * `cctp_remote_config_pda_seeds!` in
 * rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/accounts.rs.
 */
export async function deriveCctpRemoteConfigPda(
  programAddress: Address,
  domain: number,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token_cctp'),
    utf8.encode('-'),
    utf8.encode('remote_config'),
    utf8.encode('-'),
    u32.encode(domain),
  ]);
}

/**
 * ATA-payer PDA for the CCTP token program. Matches
 * `hyperlane_token_cctp_ata_payer_pda_seeds!` in
 * rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/accounts.rs.
 * (Distinct prefix from the generic `deriveAtaPayerPda` above, which is
 * `hyperlane_token`-scoped and used by collateral/synthetic tokens.)
 */
export async function deriveCctpAtaPayerPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token_cctp'),
    utf8.encode('-'),
    utf8.encode('ata_payer'),
  ]);
}

/**
 * Circle `TokenMessengerMinterV2` PDAs used by the CCTP warp token's burn
 * CPI (`processor.rs::transfer_remote_with_memo`) and mint CPI
 * (`ism.rs::verify`). Fixed/global — not per-transfer — so these belong in
 * the warp route's Address Lookup Table.
 */
export async function deriveCctpSenderAuthorityPda(): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('sender_authority'),
  ]);
}

/** Circle `MessageTransmitterV2`'s own global config PDA. */
export async function deriveCctpMessageTransmitterPda(): Promise<PdaWithBump> {
  return derive(CCTP_MESSAGE_TRANSMITTER_PROGRAM_ADDRESS, [
    utf8.encode('message_transmitter'),
  ]);
}

/** Keyed by whatever `owner` is passed to Circle's `deposit_for_burn` — the
 * CCTP warp program's own `ata_payer` PDA, not any individual end user. */
export async function deriveCctpDenylistAccountPda(
  owner: Address,
): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('denylist_account'),
    addressEncoder.encode(owner),
  ]);
}

export async function deriveCctpTokenMessengerPda(): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('token_messenger'),
  ]);
}

export async function deriveCctpTokenMinterPda(): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('token_minter'),
  ]);
}

export async function deriveCctpLocalTokenPda(
  mint: Address,
): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('local_token'),
    addressEncoder.encode(mint),
  ]);
}

/** Seeded by Circle's *decimal string* domain representation (not raw u32
 * bytes) — matches `SealevelHypCctpAdapter.buildCctpBurnAccountMetas` in
 * `@hyperlane-xyz/sdk`. */
export async function deriveCctpRemoteTokenMessengerPda(
  circleDomain: number,
): Promise<PdaWithBump> {
  return derive(CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS, [
    utf8.encode('remote_token_messenger'),
    utf8.encode(circleDomain.toString()),
  ]);
}

export async function deriveCctpEventAuthorityPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [utf8.encode('__event_authority')]);
}

export async function deriveCrossCollateralStatePda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_token'),
    utf8.encode('-'),
    utf8.encode('cross_collateral'),
  ]);
}

export async function deriveCrossCollateralDispatchAuthorityPda(
  programAddress: Address,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_cc'),
    utf8.encode('-'),
    utf8.encode('dispatch_authority'),
  ]);
}

// ====== Fee Program PDAs ======

export async function deriveFeeAccountPda(
  programAddress: Address,
  salt: ReadonlyUint8Array,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_fee'),
    utf8.encode('-'),
    utf8.encode('fee'),
    utf8.encode('-'),
    salt,
  ]);
}

export async function deriveRouteDomainPda(
  programAddress: Address,
  feeAccount: Address,
  domain: number,
): Promise<PdaWithBump> {
  return derive(programAddress, [
    utf8.encode('hyperlane_fee'),
    utf8.encode('-'),
    utf8.encode('route'),
    utf8.encode('-'),
    addressEncoder.encode(feeAccount),
    utf8.encode('-'),
    u32.encode(domain),
  ]);
}

export async function deriveStandingQuotePda(
  programAddress: Address,
  feeAccount: Address,
  domain: number,
  targetRouter: ReadonlyUint8Array,
): Promise<PdaWithBump> {
  assert(
    targetRouter.length === 32,
    `targetRouter must be 32 bytes, got ${targetRouter.length}`,
  );
  return derive(programAddress, [
    utf8.encode('hyperlane_fee'),
    utf8.encode('-'),
    utf8.encode('standing'),
    utf8.encode('-'),
    addressEncoder.encode(feeAccount),
    utf8.encode('-'),
    u32.encode(domain),
    utf8.encode('-'),
    targetRouter,
  ]);
}

export async function deriveCrossCollateralRoutePda(
  programAddress: Address,
  feeAccount: Address,
  destination: number,
  targetRouter: ReadonlyUint8Array,
): Promise<PdaWithBump> {
  assert(
    targetRouter.length === 32,
    `targetRouter must be 32 bytes, got ${targetRouter.length}`,
  );
  return derive(programAddress, [
    utf8.encode('hyperlane_fee'),
    utf8.encode('-'),
    utf8.encode('cc_route'),
    utf8.encode('-'),
    addressEncoder.encode(feeAccount),
    utf8.encode('-'),
    u32.encode(destination),
    utf8.encode('-'),
    targetRouter,
  ]);
}

// ====== BPF Loader PDAs ======

export async function deriveProgramDataAddress(
  programAddress: Address,
): Promise<Address> {
  const pda = await getProgramDerivedAddress({
    programAddress: LOADER_V3_PROGRAM_ADDRESS,
    seeds: [addressEncoder.encode(programAddress)],
  });
  return pda[0];
}
