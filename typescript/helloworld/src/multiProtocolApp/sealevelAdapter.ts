import {
  AccountMeta,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  SEALEVEL_SPL_NOOP_ADDRESS,
  SealevelAccountDataWrapper,
  SealevelCoreAdapter,
  SealevelInstructionWrapper,
  SealevelInterchainGasPaymasterConfig,
  SealevelInterchainGasPaymasterConfigSchema,
  SealevelRouterAdapter,
  SolanaWeb3Transaction,
  getSealevelAccountDataSchema,
} from '@hyperlane-xyz/sdk';
import { Address, Domain } from '@hyperlane-xyz/utils';

import { IHelloWorldAdapter } from './types.js';

export class SealevelHelloWorldAdapter
  extends SealevelRouterAdapter
  implements IHelloWorldAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { router: Address; mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async populateSendHelloTx(
    destination: ChainName,
    message: string,
    value: string,
    sender: Address,
  ): Promise<SolanaWeb3Transaction> {
    this.logger.info(
      'Creating sendHelloWorld tx for sealevel',
      this.chainName,
      destination,
      message,
      value,
    );

    const { mailbox, router: programId } = this.addresses;
    const mailboxPubKey = new PublicKey(mailbox);
    const senderPubKey = new PublicKey(sender);
    const programPubKey = new PublicKey(programId);
    const randomWallet = Keypair.generate();
    const keys = this.getSendHelloKeyList(
      programPubKey,
      mailboxPubKey,
      senderPubKey,
      randomWallet.publicKey,
    );

    const instructionData =
      new SealevelInstructionWrapper<SendHelloWorldInstruction>({
        instruction: HelloWorldInstruction.SendHelloWorld,
        data: new SendHelloWorldInstruction({
          destination: this.multiProvider.getDomainId(destination),
          message,
        }),
      });
    const serializedData = serialize(SendHelloWorldSchema, instructionData);

    const txInstruction = new TransactionInstruction({
      keys,
      programId: programPubKey,
      data: Buffer.from(serializedData),
    });

    const connection = this.getProvider();
    const recentBlockhash = (await connection.getLatestBlockhash('finalized'))
      .blockhash;
    // @ts-ignore Workaround for bug in the web3 lib, sometimes uses recentBlockhash and sometimes uses blockhash
    const transaction = new Transaction({
      feePayer: senderPubKey,
      blockhash: recentBlockhash,
      recentBlockhash,
    }).add(txInstruction);
    transaction.partialSign(randomWallet);

    return { type: ProviderType.SolanaWeb3, transaction };
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/dd7ff727b0d3d393a159afa5f0a364775bde3a58/rust/sealevel/programs/helloworld/src/processor.rs#L157
  getSendHelloKeyList(
    programId: PublicKey,
    mailbox: PublicKey,
    sender: PublicKey,
    randomWallet: PublicKey,
  ): Array<AccountMeta> {
    return [
      // 0. [writable] Program storage.
      {
        pubkey: this.deriveProgramStoragePDA(programId),
        isSigner: false,
        isWritable: true,
      },
      // 1. [executable] The mailbox.
      { pubkey: mailbox, isSigner: false, isWritable: false },
      // 2. [writeable] Outbox PDA
      {
        pubkey: SealevelCoreAdapter.deriveMailboxOutboxPda(mailbox),
        isSigner: false,
        isWritable: true,
      },
      // 3. [] Program's dispatch authority
      {
        pubkey:
          SealevelCoreAdapter.deriveMailboxDispatchAuthorityPda(programId),
        isSigner: false,
        isWritable: false,
      },
      // 4. [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 5. [executable] The spl_noop program.
      {
        pubkey: new PublicKey(SEALEVEL_SPL_NOOP_ADDRESS),
        isSigner: false,
        isWritable: false,
      },
      // 6. [signer] Tx payer.
      { pubkey: sender, isSigner: true, isWritable: true },
      // 7. [signer] Unique message account.
      { pubkey: randomWallet, isSigner: true, isWritable: false },
      // 8. [writeable] Dispatched message PDA
      {
        pubkey: SealevelCoreAdapter.deriveMailboxDispatchedMessagePda(
          mailbox,
          randomWallet,
        ),
        isSigner: false,
        isWritable: true,
      },
      /// ---- if an IGP is configured ----
      /// 9. [executable] The IGP program.
      /// 10. [writeable] The IGP program data.
      /// 11. [writeable] The gas payment PDA.
      /// 12. [] OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
      /// 13. [writeable] The IGP account.
      /// ---- end if an IGP is configured ----
    ];
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/dd7ff727b0d3d393a159afa5f0a364775bde3a58/rust/sealevel/programs/helloworld/src/processor.rs#L44
  deriveProgramStoragePDA(programId: string | PublicKey): PublicKey {
    return this.derivePda(
      ['hello_world', '-', 'handle', '-', 'storage'],
      programId,
    );
  }

  async sentStat(destination: ChainName): Promise<number> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const data = await this.getAccountInfo();
    return Number(data.sent_to.get(destinationDomain) || 0);
  }

  async getAccountInfo(): Promise<HelloWorldData> {
    const address = this.addresses.router;
    const connection = this.getProvider();

    const pda = this.deriveProgramStoragePDA(address);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo)
      throw new Error(`No account info found for ${pda.toBase58()}}`);

    const accountData = deserializeUnchecked(
      HelloWorldDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as HelloWorldData;
  }
}

/**
 * Borsh Schema
 */

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/dd7ff727b0d3d393a159afa5f0a364775bde3a58/rust/sealevel/programs/helloworld/src/instruction.rs#L40
export enum HelloWorldInstruction {
  Init,
  SendHelloWorld,
  SetInterchainSecurityModule,
  EnrollRemoteRouters,
}

export class SendHelloWorldInstruction {
  destination!: number;
  message!: string;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export const SendHelloWorldSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SendHelloWorldInstruction],
      ],
    },
  ],
  [
    SendHelloWorldInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination', 'u32'],
        ['message', 'string'],
      ],
    },
  ],
]);

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/dd7ff727b0d3d393a159afa5f0a364775bde3a58/rust/sealevel/programs/helloworld/src/accounts.rs#L20
export class HelloWorldData {
  local_domain!: Domain;
  /// The address of the mailbox contract.
  mailbox!: Uint8Array;
  mailbox_pubkey!: PublicKey;
  // The address of the ISM
  ism?: Uint8Array;
  ism_pubkey?: PublicKey;
  // The address of the IGP
  igp?: {
    program_id: Uint8Array;
    type: number;
    igp_account: Uint8Array;
  };
  igp_pubkey?: PublicKey;
  igp_account_pubkey?: PublicKey;
  // The address of the owner
  owner?: Uint8Array;
  owner_pubkey?: PublicKey;
  // A counter of how many messages have been sent from this contract.
  sent!: bigint;
  // A counter of how many messages have been received by this contract.
  received!: bigint;
  // Keyed by domain, a counter of how many messages that have been sent
  // from this contract to the domain.
  sent_to!: Map<Domain, bigint>;
  // Keyed by domain, a counter of how many messages that have been received
  // by this contract from the domain.
  received_from!: Map<Domain, bigint>;
  // Keyed by domain, the router for the remote domain.
  routers!: Map<Domain, Uint8Array>;

  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.mailbox_pubkey = new PublicKey(this.mailbox);
    this.ism_pubkey = this.ism ? new PublicKey(this.ism) : undefined;
    this.igp_pubkey = this.igp?.program_id
      ? new PublicKey(this.igp.program_id)
      : undefined;
    this.igp_account_pubkey = this.igp?.igp_account
      ? new PublicKey(this.igp.igp_account)
      : undefined;

    this.owner_pubkey = this.owner ? new PublicKey(this.owner) : undefined;
  }
}

export const HelloWorldDataSchema = new Map<any, any>([
  [SealevelAccountDataWrapper, getSealevelAccountDataSchema(HelloWorldData)],
  [
    HelloWorldData,
    {
      kind: 'struct',
      fields: [
        ['domain', 'u32'],
        ['mailbox', [32]],
        ['ism', { kind: 'option', type: [32] }],
        [
          'igp',
          {
            kind: 'option',
            type: SealevelInterchainGasPaymasterConfig,
          },
        ],
        ['owner', { kind: 'option', type: [32] }],
        ['sent', 'u64'],
        ['received', 'u64'],
        ['sent_to', { kind: 'map', key: 'u32', value: 'u64' }],
        ['received_from', { kind: 'map', key: 'u32', value: 'u64' }],
        ['routers', { kind: 'map', key: 'u32', value: [32] }],
      ],
    },
  ],
  [
    SealevelInterchainGasPaymasterConfig,
    SealevelInterchainGasPaymasterConfigSchema,
  ],
]);
