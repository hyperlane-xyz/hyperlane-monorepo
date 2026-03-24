import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { Address } from '@hyperlane-xyz/utils';

import { SEALEVEL_SPL_NOOP_ADDRESS } from '../../consts/sealevel.js';
import {
  IgpPaymentKeys,
  SealevelOverheadIgpAdapter,
} from '../../gas/adapters/SealevelIgpAdapter.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import type { IHypCrossCollateralAdapter } from './ITokenAdapter.js';
import { SealevelHypCollateralAdapter } from './SealevelTokenAdapter.js';

export class SealevelHypCrossCollateralAdapter
  extends SealevelHypCollateralAdapter
  implements IHypCrossCollateralAdapter<Transaction>
{
  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address; warpRouter: Address; mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  deriveCrossCollateralStatePda(): PublicKey {
    return this.derivePda(
      ['hyperlane_token', '-', 'cross_collateral'],
      this.warpProgramPubKey,
    );
  }

  deriveCrossCollateralDispatchAuthorityPda(): PublicKey {
    return this.derivePda(
      ['hyperlane_cc', '-', 'dispatch_authority'],
      this.warpProgramPubKey,
    );
  }

  // Stub methods — will be implemented in subsequent commits
  async quoteTransferRemoteToGas(
    _params: Parameters<
      IHypCrossCollateralAdapter<Transaction>['quoteTransferRemoteToGas']
    >[0],
  ) {
    return this.quoteTransferRemoteGas({
      destination: _params.destination,
      sender: _params.sender,
    });
  }

  // Should match rust/sealevel/programs/hyperlane-sealevel-token-cross-collateral/src/processor.rs transfer_remote_to_remote
  //
  // 0.   [executable] The system program.
  // 1.   []           The token PDA account.
  // 2.   []           The cross-collateral state PDA account.
  // 3.   [executable] The spl_noop program.
  // 4.   [executable] The mailbox program.
  // 5.   [writeable]  The mailbox outbox account.
  // 6.   []           Message dispatch authority.
  // 7.   [signer]     The token sender and mailbox payer.
  // 8.   [signer]     Unique message account.
  // 9.   [writeable]  Message storage PDA.
  // 10+. (optional)   IGP accounts.
  // N.   [executable] The SPL token program for the mint.
  // N+1. [writeable]  The mint.
  // N+2. [writeable]  The token sender's associated token account.
  // N+3. [writeable]  The escrow PDA account.
  async getTransferRemoteToRemoteKeyList({
    sender,
    mailbox,
    randomWallet,
    igp,
  }: {
    sender: PublicKey;
    mailbox: PublicKey;
    randomWallet: PublicKey;
    igp?: IgpPaymentKeys;
  }): Promise<Array<AccountMeta>> {
    let keys: Array<AccountMeta> = [
      // 0.   [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 1.   [] The token PDA account.
      {
        pubkey: this.deriveHypTokenAccount(),
        isSigner: false,
        isWritable: false,
      },
      // 2.   [] The cross-collateral state PDA account.
      {
        pubkey: this.deriveCrossCollateralStatePda(),
        isSigner: false,
        isWritable: false,
      },
      // 3.   [executable] The spl_noop program.
      {
        pubkey: new PublicKey(SEALEVEL_SPL_NOOP_ADDRESS),
        isSigner: false,
        isWritable: false,
      },
      // 4.   [executable] The mailbox program.
      { pubkey: mailbox, isSigner: false, isWritable: false },
      // 5.   [writeable] The mailbox outbox account.
      {
        pubkey: this.deriveMailboxOutboxAccount(mailbox),
        isSigner: false,
        isWritable: true,
      },
      // 6.   [] Message dispatch authority.
      {
        pubkey: this.deriveMessageDispatchAuthorityAccount(),
        isSigner: false,
        isWritable: false,
      },
      // 7.   [signer] The token sender and mailbox payer.
      { pubkey: sender, isSigner: true, isWritable: false },
      // 8.   [signer] Unique message account.
      { pubkey: randomWallet, isSigner: true, isWritable: false },
      // 9.   [writeable] Message storage PDA.
      {
        pubkey: this.deriveMsgStorageAccount(mailbox, randomWallet),
        isSigner: false,
        isWritable: true,
      },
    ];

    if (igp) {
      keys = [
        ...keys,
        // 10.   [executable] The IGP program.
        { pubkey: igp.programId, isSigner: false, isWritable: false },
        // 11.   [writeable] The IGP program data.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveIgpProgramPda(igp.programId),
          isSigner: false,
          isWritable: true,
        },
        // 12.   [writeable] Gas payment PDA.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveGasPaymentPda(
            igp.programId,
            randomWallet,
          ),
          isSigner: false,
          isWritable: true,
        },
      ];
      if (igp.overheadIgpAccount) {
        keys = [
          ...keys,
          // 13.   [] OPTIONAL - The Overhead IGP account, if the configured IGP is an Overhead IGP.
          {
            pubkey: igp.overheadIgpAccount,
            isSigner: false,
            isWritable: false,
          },
        ];
      }
      keys = [
        ...keys,
        // 14.   [writeable] The Overhead's inner IGP account (or the normal IGP account if there's no Overhead IGP).
        { pubkey: igp.igpAccount, isSigner: false, isWritable: true },
      ];
    }

    keys = [
      ...keys,
      // N.   [executable] The SPL token program for the mint.
      {
        pubkey: await this.getTokenProgramId(),
        isSigner: false,
        isWritable: false,
      },
      // N+1. [writeable] The mint.
      { pubkey: this.tokenMintPubKey, isSigner: false, isWritable: true },
      // N+2. [writeable] The token sender's associated token account.
      {
        pubkey: await this.deriveAssociatedTokenAccount(sender),
        isSigner: false,
        isWritable: true,
      },
      // N+3. [writeable] The escrow PDA account.
      { pubkey: this.deriveEscrowAccount(), isSigner: false, isWritable: true },
    ];

    return keys;
  }

  async populateTransferRemoteToTx(
    _params: Parameters<
      IHypCrossCollateralAdapter<Transaction>['populateTransferRemoteToTx']
    >[0],
  ): Promise<Transaction> {
    throw new Error('Not yet implemented');
  }
}
