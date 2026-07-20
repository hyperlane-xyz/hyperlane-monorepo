import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AccountMeta,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { Domain, assert } from '@hyperlane-xyz/utils';

import { SealevelAccountDataWrapper } from '../../utils/sealevelSerialization.js';

import { TransferRemoteParams } from './ITokenAdapter.js';
import {
  KeyListParams,
  SealevelHypTokenAdapter,
  SealevelTransferBundle,
} from './SealevelTokenAdapter.js';
import {
  SealevelCctpRemoteConfig,
  SealevelCctpRemoteConfigSchema,
} from './serialization.js';

/**
 * Circle's `TokenMessengerMinterV2` / `MessageTransmitterV2` program IDs.
 * Matches rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/circle.rs.
 */
const TOKEN_MESSENGER_MINTER_PROGRAM_ID = new PublicKey(
  'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
);
const MESSAGE_TRANSMITTER_PROGRAM_ID = new PublicKey(
  'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
);

function domainToLeBytes(domain: Domain): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(domain, 0);
  return buf;
}

// Interacts with the `hyperlane-sealevel-token-cctp` burn/mint token router.
export class SealevelHypCctpAdapter extends SealevelHypTokenAdapter {
  // CctpPlugin = [Pubkey spl_token_program, Pubkey mint, u8 ata_payer_bump].
  // Matches rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/accounts.rs.
  protected readonly pluginDataSize = 65;

  // CCTP tokens are held in a plain ATA (no escrow), same as collateral's
  // beneficiary derivation.
  protected override async deriveFeeBeneficiary(
    beneficiaryOwner: PublicKey,
  ): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(
      this.tokenMintPubKey,
      beneficiaryOwner,
      false,
      await this.getTokenProgramId(),
    );
  }

  /**
   * `getTransferInstructionKeyList` (invoked from within the base class's
   * `getTransferRemoteIxBundle`) receives neither `destination` nor a way to
   * add extra required signers back out to the caller. Both are threaded
   * through via this pending state, set immediately before the `super` call
   * and cleared right after — safe because adapters are constructed fresh
   * per warp operation (see `SealevelHypTokenAdapter`'s ALT-cache doc comment)
   * and this method's own call chain is not reentrant.
   */
  private pendingDestination?: Domain;
  private pendingEventDataAccount?: PublicKey;

  override async getTransferRemoteIxBundle(
    params: TransferRemoteParams & { scopedSalt?: Uint8Array },
  ): Promise<SealevelTransferBundle> {
    const eventDataKeypair = Keypair.generate();
    this.pendingDestination = params.destination;
    this.pendingEventDataAccount = eventDataKeypair.publicKey;
    try {
      const bundle = await super.getTransferRemoteIxBundle(params);
      // `getTransferRemoteIxBundle`'s return value is the only channel back
      // to the caller — callers that pre-generate `params.extraSigners` (e.g.
      // WarpCore, for re-signing on blockhash-expiry resubmit) only learn
      // about signers appended to that same array, not ones in `bundle.signers`.
      // Push here too so this CCTP-only ephemeral signer isn't silently dropped.
      params.extraSigners?.push(eventDataKeypair);
      return { ...bundle, signers: [...bundle.signers, eventDataKeypair] };
    } finally {
      this.pendingDestination = undefined;
      this.pendingEventDataAccount = undefined;
    }
  }

  // Should match the account list `transfer_remote_with_memo` consumes in
  // rust/sealevel/programs/hyperlane-sealevel-token-cctp/src/processor.rs
  // (indices 0-21) — this program parses these itself to perform the real
  // Circle burn CPI, before delegating the remaining accounts to the generic
  // library's transfer_remote dispatch (built by `super` below).
  override async getTransferInstructionKeyList(
    params: KeyListParams,
  ): Promise<Array<AccountMeta>> {
    assert(
      this.pendingDestination !== undefined && this.pendingEventDataAccount,
      'CCTP transfer state not initialized — getTransferRemoteIxBundle must run first',
    );
    const cctpAccounts = await this.buildCctpBurnAccountMetas(
      params.sender,
      this.pendingDestination,
      this.pendingEventDataAccount,
    );
    return [
      ...cctpAccounts,
      ...(await super.getTransferInstructionKeyList(params)),
    ];
  }

  /**
   * This program's `ata_payer` PDA — signs (via `invoke_signed`) both the
   * escrow-ATA creation and Circle's `owner` role for the burn, so Circle
   * records this PDA (not the sender) as the burn's `messageSender`. Matches
   * `TokenBridgeCctpBase.cctpAuthorityOverrides` on the EVM side, which is
   * configured with this exact PDA per Sealevel origin domain.
   */
  private deriveAtaPayer(): PublicKey {
    return this.derivePda(
      ['hyperlane_token_cctp', '-', 'ata_payer'],
      this.warpProgramPubKey,
    );
  }

  private async buildCctpBurnAccountMetas(
    sender: PublicKey,
    destination: Domain,
    eventDataAccount: PublicKey,
  ): Promise<AccountMeta[]> {
    const remoteConfig = await this.getRemoteConfig(destination);
    const tokenProgramId = await this.getTokenProgramId();
    const ownerTokenAccount = await this.deriveAssociatedTokenAccount(sender);
    const ataPayer = this.deriveAtaPayer();
    const ataPayerAta = await this.deriveAssociatedTokenAccount(ataPayer);

    const senderAuthority = this.derivePda(
      ['sender_authority'],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const denylistAccount = this.derivePda(
      ['denylist_account', ataPayer.toBuffer()],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const messageTransmitter = this.derivePda(
      ['message_transmitter'],
      MESSAGE_TRANSMITTER_PROGRAM_ID,
    );
    const tokenMessenger = this.derivePda(
      ['token_messenger'],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const remoteTokenMessenger = this.derivePda(
      [
        'remote_token_messenger',
        Buffer.from(remoteConfig.circle_domain.toString()),
      ],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const tokenMinter = this.derivePda(
      ['token_minter'],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const localToken = this.derivePda(
      ['local_token', this.tokenMintPubKey.toBuffer()],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );
    const eventAuthority = this.derivePda(
      ['__event_authority'],
      TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    );

    return [
      // 0. [] This program's own HyperlaneToken<CctpPlugin> config PDA.
      {
        pubkey: this.deriveHypTokenAccount(),
        isSigner: false,
        isWritable: false,
      },
      // 1. [] The remote-config PDA for the destination domain.
      {
        pubkey: this.deriveCctpRemoteConfigAccount(destination),
        isSigner: false,
        isWritable: false,
      },
      // 2. [signer] The sender wallet — authorizes the escrow transfer out
      //    of their own USDC account. No longer passed to Circle as `owner`.
      { pubkey: sender, isSigner: true, isWritable: false },
      // 3. [writable] The sender's USDC token account (escrow transfer source).
      { pubkey: ownerTokenAccount, isSigner: false, isWritable: true },
      // 4. [signer, writable] The event-rent payer for Circle's CPI.
      { pubkey: sender, isSigner: true, isWritable: true },
      // 5. [writable] This program's `ata_payer` PDA.
      { pubkey: ataPayer, isSigner: false, isWritable: true },
      // 6. [writable] ata_payer's own associated token account for the USDC
      //    mint (escrow account — burned from).
      { pubkey: ataPayerAta, isSigner: false, isWritable: true },
      // 7. [] TokenMessengerMinterV2's sender_authority PDA.
      { pubkey: senderAuthority, isSigner: false, isWritable: false },
      // 8. [] ata_payer's denylist_account PDA.
      { pubkey: denylistAccount, isSigner: false, isWritable: false },
      // 9. [writable] Circle's message_transmitter global config PDA.
      { pubkey: messageTransmitter, isSigner: false, isWritable: true },
      // 10. [] Circle's token_messenger singleton config.
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },
      // 11. [] The remote_token_messenger PDA for the destination Circle domain.
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
      // 12. [] Circle's token_minter singleton config.
      { pubkey: tokenMinter, isSigner: false, isWritable: false },
      // 13. [writable] The local_token PDA for the USDC mint.
      { pubkey: localToken, isSigner: false, isWritable: true },
      // 14. [writable] The USDC mint.
      { pubkey: this.tokenMintPubKey, isSigner: false, isWritable: true },
      // 15. [signer, writable] A fresh, uninitialized account for Circle's
      //     message_sent_event_data.
      { pubkey: eventDataAccount, isSigner: true, isWritable: true },
      // 16. [] MessageTransmitterV2's own program account.
      {
        pubkey: MESSAGE_TRANSMITTER_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      // 17. [] TokenMessengerMinterV2's own program account.
      {
        pubkey: TOKEN_MESSENGER_MINTER_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      // 18. [executable] The SPL token program.
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      // 19. [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 20. [] TokenMessengerMinterV2's event_authority PDA.
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      // 21. [executable] The SPL associated-token-account program.
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ];
  }

  deriveCctpRemoteConfigAccount(destination: Domain): PublicKey {
    return this.derivePda(
      [
        'hyperlane_token_cctp',
        '-',
        'remote_config',
        '-',
        domainToLeBytes(destination),
      ],
      this.warpProgramPubKey,
    );
  }

  private async getRemoteConfig(
    destination: Domain,
  ): Promise<SealevelCctpRemoteConfig> {
    const pda = this.deriveCctpRemoteConfigAccount(destination);
    const info = await this.getProvider().getAccountInfo(pda);
    assert(
      info,
      `CCTP remote config for domain ${destination} not found at ${pda.toBase58()} — ` +
        'was addDomain/SetRemoteConfig run for this destination?',
    );
    const wrapped = deserializeUnchecked(
      SealevelCctpRemoteConfigSchema,
      SealevelAccountDataWrapper,
      info.data,
    );
    const data = wrapped.data;
    assert(
      data instanceof SealevelCctpRemoteConfig,
      'Decoded wrapper.data is not SealevelCctpRemoteConfig',
    );
    return data;
  }
}
