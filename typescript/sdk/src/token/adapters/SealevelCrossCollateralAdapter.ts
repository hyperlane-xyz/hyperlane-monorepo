import {
  AccountMeta,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { serialize } from 'borsh';
import { Address, assert } from '@hyperlane-xyz/utils';

import { SEALEVEL_SPL_NOOP_ADDRESS } from '../../consts/sealevel.js';
import {
  IgpPaymentKeys,
  SealevelOverheadIgpAdapter,
} from '../../gas/adapters/SealevelIgpAdapter.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import type { IHypCrossCollateralAdapter } from './ITokenAdapter.js';
import { SealevelHypCollateralAdapter } from './SealevelTokenAdapter.js';
import { SealevelInstructionWrapper } from '../../utils/sealevelSerialization.js';
import {
  SealevelCCHandleLocalInstruction,
  SealevelCCHandleLocalSchema,
  SealevelCCInstructionKind,
} from './serialization.js';

// CC program discriminator (8 bytes of 2s)
const CC_DISCRIMINATOR = Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]);

// Each SerializableAccountMeta is: pubkey (32) + is_signer (1) + is_writable (1) = 34 bytes
const SERIALIZABLE_ACCOUNT_META_SIZE = 34;

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

  // Simulates the HandleLocalAccountMetas instruction to discover the
  // accounts needed by the target program's HandleLocal CPI call.
  // Same simulation pattern as SealevelIgpAdapter.quoteGasPayment.
  async simulateHandleLocalAccountMetas({
    targetProgram,
    senderProgram,
    amount,
    recipient,
    payer,
  }: {
    targetProgram: PublicKey;
    senderProgram: PublicKey;
    amount: bigint;
    recipient: Uint8Array;
    payer: PublicKey;
  }): Promise<Array<AccountMeta>> {
    const value = new SealevelInstructionWrapper({
      instruction: SealevelCCInstructionKind.HandleLocalAccountMetas,
      data: new SealevelCCHandleLocalInstruction({
        sender_program_id: senderProgram.toBytes(),
        amount_or_id: amount,
        recipient,
      }),
    });
    const serializedData = serialize(SealevelCCHandleLocalSchema, value);

    const instruction = new TransactionInstruction({
      keys: [
        // The token PDA account.
        {
          pubkey: this.deriveHypTokenAccount(),
          isSigner: false,
          isWritable: false,
        },
        // The CC state PDA account.
        {
          pubkey: this.deriveCrossCollateralStatePda(),
          isSigner: false,
          isWritable: false,
        },
        // The target program (executable).
        { pubkey: targetProgram, isSigner: false, isWritable: false },
      ],
      programId: this.warpProgramPubKey,
      data: Buffer.concat([CC_DISCRIMINATOR, Buffer.from(serializedData)]),
    });

    const message = Message.compile({
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [instruction],
      payerKey: payer,
    });

    const tx = new VersionedTransaction(message);
    const connection = this.getProvider();
    const simulationResponse = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });

    const base64Data = simulationResponse.value.returnData?.data?.[0];
    assert(
      base64Data,
      'No return data from HandleLocalAccountMetas simulation',
    );

    const data = Buffer.from(base64Data, 'base64');
    // First 4 bytes are the Vec length (little-endian u32)
    const count = data.readUInt32LE(0);
    const accountMetas: Array<AccountMeta> = [];
    for (let i = 0; i < count; i++) {
      const offset = 4 + i * SERIALIZABLE_ACCOUNT_META_SIZE;
      const pubkey = new PublicKey(data.subarray(offset, offset + 32));
      const isSigner = data[offset + 32] !== 0;
      const isWritable = data[offset + 33] !== 0;
      accountMetas.push({ pubkey, isSigner, isWritable });
    }

    return accountMetas;
  }

  async populateTransferRemoteToTx(
    _params: Parameters<
      IHypCrossCollateralAdapter<Transaction>['populateTransferRemoteToTx']
    >[0],
  ): Promise<Transaction> {
    throw new Error('Not yet implemented');
  }
}
